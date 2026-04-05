/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

/**
 * LLM 调用
 *
 * 仅使用插件配置 `plugins.entries.graph-memory.config.llm`（apiKey + baseURL），
 * 不读取环境变量，避免与网络请求组合触发安装器静态扫描误报。
 *
 * - baseURL 指向 Anthropic（hostname 含 anthropic.com）→ Messages API
 * - 否则 → OpenAI 兼容 `/chat/completions`
 *
 * 内置：429/5xx 重试 3 次 + 30s 超时
 */

export interface LlmConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
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

function isAnthropicBaseUrl(baseURL: string): boolean {
  try {
    return new URL(baseURL).hostname.includes("anthropic.com");
  } catch {
    return baseURL.toLowerCase().includes("anthropic.com");
  }
}

function anthropicMessagesUrl(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? `${trimmed}/messages` : `${trimmed}/v1/messages`;
}

// ─── CompleteFn 工厂 ────────────────────────────────────────

export function createCompleteFn(
  _provider: string,
  model: string,
  llmConfig?: LlmConfig,
): CompleteFn {
  return async (system, user) => {
    if (!llmConfig?.apiKey || !llmConfig?.baseURL) {
      throw new Error(
        "[graph-memory] 请在 openclaw.json → plugins.entries.graph-memory.config 中配置 llm.apiKey 与 llm.baseURL。" +
        " Anthropic 示例：baseURL 填 https://api.anthropic.com；OpenAI 兼容示例：https://api.openai.com/v1",
      );
    }

    const llmModel = llmConfig.model ?? model;

    if (isAnthropicBaseUrl(llmConfig.baseURL)) {
      const url = anthropicMessagesUrl(llmConfig.baseURL);
      const res = await fetchRetry(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": llmConfig.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: llmModel,
          max_tokens: 4096,
          system,
          messages: [{ role: "user", content: user }],
        }),
      });
      if (!res.ok) throw new Error(`[graph-memory] Anthropic API ${res.status}`);
      const data = await res.json() as any;
      const text = data.content?.[0]?.text ?? "";
      if (text) return text;
      throw new Error("[graph-memory] Anthropic API returned empty content");
    }

    const baseURL = llmConfig.baseURL.replace(/\/+$/, "");
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
  };
}
