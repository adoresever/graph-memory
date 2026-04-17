/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

/**
 * LLM 调用
 *
 * 路径 A：pluginConfig.llm 配置直接调 OpenAI 兼容 API
 * 路径 B：直接调 Anthropic REST API（需 ANTHROPIC_API_KEY）
 * 路径 C：OAuth Codex Responses API（需 llm.auth="oauth"）
 *
 * 内置：429/5xx 重试 3 次 + 30s 超时
 */

import {
  loadOAuthSession,
  needsRefresh,
  refreshOAuthSession,
  saveOAuthSession,
  normalizeOauthModel,
  buildOauthEndpoint,
  extractOutputTextFromSse,
} from "./oauth.js";
import type { OAuthSession } from "./oauth.js";

export interface LlmConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  auth?: "api-key" | "oauth";
  oauthPath?: string;
  oauthProvider?: string;
  timeoutMs?: number;
}

export type CompleteFn = (system: string, user: string) => Promise<string>;

// ─── 带重试+超时的 fetch ─────────────────────────────────────

const RETRYABLE = new Set([429, 500, 502, 503, 529]);

async function fetchRetry(url: string, init: RequestInit, retries = 3, timeoutMs = 30_000): Promise<Response> {
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok || i >= retries || !RETRYABLE.has(res.status)) return res;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
    } catch (err: any) {
      clearTimeout(t);
      if (i >= retries) throw err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw new Error("[graph-memory] fetch failed after retries");
}

// ─── CompleteFn 工厂 ────────────────────────────────────────

export function createCompleteFn(
  provider: string,
  model: string,
  llmConfig?: LlmConfig,
  anthropicApiKey?: string,
): CompleteFn {
  // ── Pre-resolve OAuth config to avoid non-null assertions in hot path ──
  const oauthPath = llmConfig?.auth === "oauth" ? llmConfig.oauthPath : undefined;
  const oauthTimeout = llmConfig?.timeoutMs;

  // ── OAuth session cache ───────────────────────────────────
  let cachedSessionPromise: Promise<OAuthSession> | null = null;
  let refreshPromise: Promise<OAuthSession> | null = null;

  async function getOAuthSession(): Promise<OAuthSession> {
    if (!oauthPath) {
      throw new Error("[graph-memory] OAuth mode requires llm.oauthPath");
    }
    if (!cachedSessionPromise) {
      cachedSessionPromise = loadOAuthSession(oauthPath).catch((error) => {
        cachedSessionPromise = null;
        throw error;
      });
    }
    let session = await cachedSessionPromise;
    if (needsRefresh(session)) {
      if (!refreshPromise) {
        refreshPromise = refreshOAuthSession(session, oauthTimeout)
          .then(async (s) => {
            await saveOAuthSession(oauthPath, s);
            cachedSessionPromise = Promise.resolve(s);
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

  return async (system, user) => {
    // ── 路径 C（OAuth）：Codex Responses API ────────────────
    if (llmConfig?.auth === "oauth") {
      if (!llmConfig.oauthPath) {
        throw new Error("[graph-memory] OAuth mode requires llm.oauthPath");
      }
      const session = await getOAuthSession();
      const endpoint = buildOauthEndpoint(llmConfig.baseURL, llmConfig.oauthProvider);
      const oauthModel = normalizeOauthModel(llmConfig.model ?? model);

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
          store: false,
          stream: false,
          text: { format: { type: "text" } },
        }),
      }, 3, llmConfig.timeoutMs ?? 30_000);

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`[graph-memory] OAuth LLM API ${res.status}: ${errText.slice(0, 500)}`);
      }

      const bodyText = await res.text();

      // Non-streaming: parse as JSON and extract output text
      let text: string | null = null;
      try {
        const parsed = JSON.parse(bodyText) as Record<string, unknown>;
        const output = Array.isArray(parsed.output) ? parsed.output : [];
        for (const item of output) {
          if (!item || typeof item !== "object") continue;
          const content = Array.isArray((item as Record<string, unknown>).content)
            ? (item as Record<string, unknown>).content as Array<Record<string, unknown>>
            : [];
          for (const part of content) {
            if (part?.type === "output_text" && typeof part.text === "string") {
              text = (text ?? "") + part.text;
            }
          }
        }
      } catch {
        // fallback: try SSE parsing in case server ignored stream:false
        text = extractOutputTextFromSse(bodyText);
      }

      if (text) return text;
      throw new Error("[graph-memory] OAuth LLM returned empty content");
    }

    // ── 路径 A（优先）：pluginConfig.llm 直接调 OpenAI 兼容 API ──
    if (llmConfig?.apiKey && llmConfig?.baseURL) {
      const baseURL = llmConfig.baseURL.replace(/\/+$/, "");
      const llmModel = llmConfig.model ?? model;
      const res = await fetchRetry(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${llmConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: llmModel,
          messages: [
            ...(system.trim() ? [{ role: "system", content: system.trim() }] : []),
            { role: "user", content: user },
          ],
          temperature: 0.1,
        }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`[graph-memory] LLM API ${res.status}: ${errText.slice(0, 200)}`);
      }
      const data = await res.json() as any;
      const text = data.choices?.[0]?.message?.content ?? "";
      if (text) return text;
      throw new Error("[graph-memory] LLM returned empty content");
    }

    // ── 路径 B：Anthropic API ──────────────────────────────
    if (!anthropicApiKey) {
      throw new Error(
        "[graph-memory] No LLM available. 在 openclaw.json 的 graph-memory config 中配置 llm.apiKey + llm.baseURL",
      );
    }
    const res = await fetchRetry("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": anthropicApiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: llmConfig?.model ?? model, max_tokens: 4096, system, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error(`[graph-memory] Anthropic API ${res.status}`);
    const data = await res.json() as any;
    const text = data.content?.[0]?.text ?? "";
    if (text) return text;
    throw new Error("[graph-memory] Anthropic API returned empty content");
  };
}