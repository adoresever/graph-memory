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
 *
 * 内置：429/5xx 重试 3 次 + 30s 超时
 */

import { LlmFailureGuard } from "./llm-guard.ts";

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

// ─── CompleteFn 工厂 ────────────────────────────────────────

export function createCompleteFn(
  provider: string,
  model: string,
  llmConfig?: LlmConfig,
  anthropicApiKey?: string,
): CompleteFn {
  const guard = new LlmFailureGuard();

  return async (system, user) => {
    if (!guard.canRun()) {
      const seconds = Math.max(1, Math.ceil(guard.remainingMs() / 1000));
      throw new Error(
        `[graph-memory] LLM paused for ${seconds}s after a previous permanent API error`,
      );
    }

    try {
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
        if (!text) throw new Error("[graph-memory] LLM returned empty content");
        guard.reset();
        return text;
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
      if (!text) throw new Error("[graph-memory] Anthropic API returned empty content");
      guard.reset();
      return text;
    } catch (error) {
      if (guard.tripIfNeeded(error)) {
        const seconds = Math.max(1, Math.ceil(guard.remainingMs() / 1000));
        throw new Error(`${String(error)}; pausing graph-memory LLM calls for ${seconds}s`);
      }
      throw error;
    }
  };
}
