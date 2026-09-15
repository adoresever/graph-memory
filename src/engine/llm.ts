/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

/**
 * LLM 调用
 *
 * 显式 provider 路由（修 issue #48：日志/实际路由脱节）：
 *   provider: "openai"    → OpenAI 兼容协议（/chat/completions），需 baseURL + apiKey
 *   provider: "anthropic" → Anthropic Messages API（/v1/messages），需 apiKey；baseURL 默认 https://api.anthropic.com
 *   provider: "oauth"     → OpenAI Codex Responses API（/codex/responses），需 oauthPath；用 PKCE OAuth bearer token
 *
 * 向后兼容（未显式设 provider 时按旧行为推断，但告警提示显式设置）：
 *   - 配了 baseURL → 推断为 "openai"
 *   - 仅配 apiKey  → 推断为 "anthropic"
 *
 * "oauth" 必须显式声明（不会从启发式推断中产生）。
 *
 * 三条路径共用 effectiveModel（由调用方合并 cfg.llm.model ?? agents.defaults.model）。
 * 超时：AbortController 强制；默认 60s，cfg.llm.timeoutMs 可调（慢速 API 用户可调大）。
 */

import { stat } from "node:fs/promises";
import { LlmFailureGuard } from "./llm-guard.ts";
import {
  loadOAuthSession,
  needsRefresh,
  refreshOAuthSession,
  saveOAuthSession,
  normalizeOauthModel,
  buildOauthEndpoint,
  extractOutputTextFromSse,
  extractOutputTextFromResponsePayload,
} from "./oauth.ts";
import type { OAuthSession } from "./oauth.ts";
import { fetchRetry, throwForStatus } from "./http.ts";

export type LlmProvider = "openai" | "anthropic" | "oauth";

/** OpenAI Codex Responses API 思考强度。low=快速、medium=平衡、high=深度推理。 */
export type ReasoningEffort = "low" | "medium" | "high";

const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

interface LlmConfig {
  /** 显式 provider 切换。未设时按 baseURL 是否存在推断（向后兼容，仅产生 openai/anthropic）。 */
  provider?: LlmProvider;
  apiKey?: string;
  baseURL?: string;
  model?: string;
  /** 单次 LLM 请求超时（毫秒）。未配时默认 60000。OAuth 刷新令牌也用此值。 */
  timeoutMs?: number;
  maxTokens?: number;
  /** OAuth 会话文件路径（provider="oauth" 时必填）。文件由 `openclaw graph-memory auth login` 生成。 */
  oauthPath?: string;
  /** OAuth 提供商标识（默认 "openai-codex"，目前仅支持此一种）。 */
  oauthProvider?: string;
  /** 推理模型思考强度（仅 oauth provider 生效；默认 "medium"）。 */
  reasoningEffort?: ReasoningEffort;
}

export type CompleteFn = (system: string, user: string) => Promise<string>;

/**
 * 剥离推理模型输出的 <think>...</think> 思维链标签（兼容 MiniMax 等），
 * 含未闭合 <think> 兜底。LLM 输出清洗的单一来源——extractor 与社区摘要共用。
 */
export function stripThinkTags(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*/gi, "");
}

const DEFAULT_LLM_TIMEOUT_MS = 60_000;
const DEFAULT_LLM_MAX_TOKENS = 4_000;
const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

/**
 * 解析 provider：显式 > 启发式推断。
 * 返回 provider 和是否为推断值（用于告警）。
 *
 * 注意：oauth 永远不会被推断出来——必须显式声明。
 */
export function resolveProvider(cfg: LlmConfig | undefined): {
  provider: LlmProvider;
  inferred: boolean;
} {
  if (cfg?.provider === "openai" || cfg?.provider === "anthropic" || cfg?.provider === "oauth") {
    return { provider: cfg.provider, inferred: false };
  }
  // 向后兼容：未显式设 provider 时按 baseURL 推断（仅 openai/anthropic）
  const inferred = cfg?.baseURL ? "openai" : "anthropic";
  return { provider: inferred, inferred: true };
}

/**
 * 构造 LLM CompleteFn。
 *
 * @param effectiveModel 已合并后的模型名（cfg.llm.model ?? agents.defaults.model）。
 * @param llmConfig       插件 config.llm（provider / apiKey / baseURL / model / timeoutMs）。
 */
export function createCompleteFn(
  effectiveModel: string,
  llmConfig?: LlmConfig,
): CompleteFn {
  const { provider } = resolveProvider(llmConfig);
  const timeoutMs = llmConfig?.timeoutMs && llmConfig.timeoutMs > 0
    ? llmConfig.timeoutMs
    : DEFAULT_LLM_TIMEOUT_MS;
  const maxTokens = llmConfig?.maxTokens && llmConfig.maxTokens > 0
    ? llmConfig.maxTokens
    : DEFAULT_LLM_MAX_TOKENS;
  const reasoningEffort: ReasoningEffort =
    llmConfig?.reasoningEffort === "low" ||
    llmConfig?.reasoningEffort === "medium" ||
    llmConfig?.reasoningEffort === "high"
      ? llmConfig.reasoningEffort
      : DEFAULT_REASONING_EFFORT;

  // ── OAuth 会话缓存：单飞刷新，避免并发请求同时触发 refresh ──
  const oauthPath = provider === "oauth" ? llmConfig?.oauthPath : undefined;
  let cachedSessionPromise: Promise<OAuthSession> | null = null;
  let cachedSessionMtimeMs: number | null = null;
  let refreshPromise: Promise<OAuthSession> | null = null;

  async function getOAuthSession(): Promise<OAuthSession> {
    if (!oauthPath) {
      throw new Error("[graph-memory] provider=oauth 需要 llm.oauthPath");
    }
    // oauthPath 可能被运行中的其他进程重写（CLI auth login / CLI extract 刷新 token）。
    // 进程内缓存按 mtime 失效：文件更新后下一次调用即重载，无需重启网关。
    let mtimeMs: number | null = null;
    try { mtimeMs = (await stat(oauthPath)).mtimeMs; } catch { /* 文件暂不可达：沿用缓存 */ }
    if (!cachedSessionPromise || (mtimeMs !== null && mtimeMs !== cachedSessionMtimeMs)) {
      cachedSessionMtimeMs = mtimeMs;
      cachedSessionPromise = loadOAuthSession(oauthPath).catch((error) => {
        cachedSessionPromise = null;
        throw error;
      });
    }
    let session = await cachedSessionPromise;
    if (needsRefresh(session)) {
      if (!refreshPromise) {
        refreshPromise = refreshOAuthSession(session, timeoutMs)
          .then(async (s) => {
            await saveOAuthSession(oauthPath, s);
            cachedSessionPromise = Promise.resolve(s);
            // 同步 mtime 标记，避免下次调用因文件刚写入而多余重载一次
            try { cachedSessionMtimeMs = (await stat(oauthPath)).mtimeMs; } catch {}
            refreshPromise = null;
            return s;
          })
          .catch((err) => {
            refreshPromise = null;
            throw err;
          });
      }
      session = await refreshPromise;
    }
    return session;
  }

  const complete = async (system: string, user: string): Promise<string> => {
    // ── 路径 C：OAuth Codex Responses API ──
    if (provider === "oauth") {
      if (!oauthPath) {
        throw new Error("[graph-memory] provider=oauth 需要 llm.oauthPath");
      }
      const session = await getOAuthSession();
      const endpoint = buildOauthEndpoint(llmConfig?.baseURL, llmConfig?.oauthProvider);
      const oauthModel = normalizeOauthModel(llmConfig?.model ?? effectiveModel);

      const res = await fetchRetry(endpoint, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${session.accessToken}`,
          "Content-Type": "application/json",
          "Accept": "text/event-stream",
          "OpenAI-Beta": "responses=experimental",
          "chatgpt-account-id": session.accountId,
          "originator": "codex_cli_rs",
        },
        body: JSON.stringify({
          model: oauthModel,
          instructions: system.trim(),
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: user }],
            },
          ],
          reasoning: { effort: reasoningEffort },
          store: false,
          stream: false,
          text: { format: { type: "text" } },
        }),
      }, { retries: 3, timeoutMs, label: "[graph-memory] LLM" });

      if (!res.ok) {
        await throwForStatus(res, "[graph-memory] OAuth LLM API", 500);
      }

      const bodyText = await res.text();
      let text: string | null = null;
      try {
        // Responses JSON → output_text 收集（与 oauth.ts 的 SSE 嵌套解析共用同一遍历）
        text = extractOutputTextFromResponsePayload(JSON.parse(bodyText));
      } catch {
        // 服务器忽略 stream:false 时回退到 SSE 解析
        text = extractOutputTextFromSse(bodyText);
      }

      if (text) return text;
      throw new Error("[graph-memory] OAuth LLM returned empty content");
    }

    if (provider === "anthropic") {
      // ── Anthropic Messages API ──
      const key = llmConfig?.apiKey;
      if (!key) {
        throw new Error(
          "[graph-memory] llm.provider=anthropic 但未配 llm.apiKey。请在 graph-memory config.llm 中配置 apiKey",
        );
      }
      const baseURL = (llmConfig?.baseURL ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, "");
      const res = await fetchRetry(`${baseURL}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: effectiveModel,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: user }],
        }),
      }, { retries: 3, timeoutMs, label: "[graph-memory] LLM" });
      if (!res.ok) {
        await throwForStatus(res, "[graph-memory] Anthropic API");
      }
      const data = await res.json() as any;
      // 遍历 content 找 text 块：只看 content[0] 时，thinking 块在前会误报 empty content
      const text = Array.isArray(data.content)
        ? data.content
            .filter((b: any) => b?.type === "text" && typeof b.text === "string")
            .map((b: any) => b.text)
            .join("")
        : "";
      if (text) return text;
      const stop = data.choices?.[0]?.finish_reason ?? data.stop_reason;
      throw new Error(
        `[graph-memory] LLM returned empty content${stop ? ` (stop_reason=${stop})` : ""}. ` +
        `Reasoning models may exhaust max_tokens (${maxTokens}); raise llm.maxTokens if recurring.`,
      );
    }

    // ── OpenAI 兼容 /chat/completions ──
    const apiKey = llmConfig?.apiKey;
    const baseURL = llmConfig?.baseURL;
    if (!apiKey || !baseURL) {
      throw new Error(
        "[graph-memory] llm.provider=openai 需要 llm.apiKey + llm.baseURL。请在 graph-memory config.llm 中配置",
      );
    }
    const url = `${baseURL.replace(/\/+$/, "")}/chat/completions`;
    const res = await fetchRetry(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: effectiveModel,
        messages: [
          ...(system.trim() ? [{ role: "system", content: system.trim() }] : []),
          { role: "user", content: user },
        ],
        max_tokens: maxTokens,
        temperature: 0.1,
      }),
    }, { retries: 3, timeoutMs, label: "[graph-memory] LLM" });
    if (!res.ok) {
      await throwForStatus(res, "[graph-memory] LLM API");
    }
    const data = await res.json() as any;
    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? "";
    if (text) return text;
    const stop = choice?.finish_reason;
    const reasoningTokens = data?.usage?.completion_tokens_details?.reasoning_tokens;
    throw new Error(
      `[graph-memory] LLM returned empty content${stop ? ` (finish_reason=${stop})` : ""}` +
      (reasoningTokens ? ` — reasoning consumed ${reasoningTokens} of ${maxTokens} tokens` : "") +
      `. Raise llm.maxTokens if recurring.`,
    );
  };

  // ── 失败冷却守卫：持久性配置错误（401/403/404）后冷却 10 分钟，快速失败 ──
  // 避免凭证失效/模型名错误时每轮照付一次完整请求 + 超时等待。成功调用即清除。
  // OAuth 例外自愈：oauthPath 可能被外部进程重写（CLI auth login / CLI extract
  // 刷新 token）。冷却触发时记录会话文件 mtime，后续调用发现文件已变化 =
  // 凭证已被修复 → 立即解除冷却重试（401 的常见诱因是时钟偏移导致缓存的
  // access token 提前过期，重登即可恢复，不应被迫等满 10 分钟）。
  const guard = new LlmFailureGuard();
  let oauthTripMtimeMs: number | null | undefined; // undefined = 冷却非 oauth 路径触发
  return async (system: string, user: string): Promise<string> => {
    if (!guard.canRun()) {
      if (provider === "oauth" && oauthPath && oauthTripMtimeMs !== undefined) {
        let currentMtimeMs: number | null = null;
        try { currentMtimeMs = (await stat(oauthPath)).mtimeMs; } catch { /* 文件暂不可达：维持冷却 */ }
        // 仅在"确实读到不同的 mtime"或"trip 时读不到、现在读得到"时解除；
        // 瞬时 stat 失败（null）不解除 —— 避免 AV/EBUSY 类抖动白白放行一次必败请求
        const fileReplaced = oauthTripMtimeMs === null
          ? currentMtimeMs !== null
          : currentMtimeMs !== null && currentMtimeMs !== oauthTripMtimeMs;
        if (fileReplaced) guard.reset();
      }
      if (!guard.canRun()) {
        const seconds = Math.max(1, Math.ceil(guard.remainingMs() / 1000));
        throw new Error(
          `[graph-memory] LLM paused for ${seconds}s after a previous permanent API error` +
          (provider === "oauth" ? " — 重新 auth login 或等待 token 文件刷新后自动解除" : ""),
        );
      }
    }
    try {
      const text = await complete(system, user);
      guard.reset();
      return text;
    } catch (err) {
      if (guard.tripIfNeeded(err) && provider === "oauth" && oauthPath) {
        try { oauthTripMtimeMs = (await stat(oauthPath)).mtimeMs; }
        catch { oauthTripMtimeMs = null; }
      }
      throw err;
    }
  };
}
