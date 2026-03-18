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
 */

export interface LlmConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

export type CompleteFn = (system: string, user: string) => Promise<string>;

export function createCompleteFn(
  provider: string,
  model: string,
  llmConfig?: LlmConfig,
): CompleteFn {
  return async (system, user) => {
    // ── 路径 A（优先）：pluginConfig.llm 直接调 OpenAI 兼容 API ──
    if (llmConfig?.apiKey && llmConfig?.baseURL) {
      const baseURL = llmConfig.baseURL.replace(/\/+$/, "");
      const llmModel = llmConfig.model ?? model;
      const res = await fetch(`${baseURL}/chat/completions`, {
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
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        "[graph-memory] No LLM available. 在 openclaw.json 的 graph-memory config 中配置 llm.apiKey + llm.baseURL",
      );
    }
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 4096, system, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error(`[graph-memory] Anthropic API ${res.status}`);
    return ((await res.json() as any).content?.[0]?.text) ?? "";
  };
}