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
import { LlmFailureGuard } from "./llm-guard.js";
import { GRAPH_EXTRACTION_TOOL, GRAPH_EXTRACTION_TOOL_NAME, } from "../extractor/contract.js";
function openAiStructuredArguments(data) {
    const calls = data?.choices?.[0]?.message?.tool_calls;
    if (!Array.isArray(calls) || calls.length !== 1) {
        throw new Error(`[graph-memory] OpenAI-compatible LLM must call ${GRAPH_EXTRACTION_TOOL_NAME} exactly once`);
    }
    const call = calls[0]?.function;
    if (call?.name !== GRAPH_EXTRACTION_TOOL_NAME || typeof call?.arguments !== "string" || !call.arguments.trim()) {
        throw new Error(`[graph-memory] OpenAI-compatible LLM returned an invalid ${GRAPH_EXTRACTION_TOOL_NAME} call`);
    }
    return call.arguments;
}
function anthropicStructuredArguments(data) {
    const calls = Array.isArray(data?.content)
        ? data.content.filter((block) => block?.type === "tool_use")
        : [];
    if (calls.length !== 1 || calls[0]?.name !== GRAPH_EXTRACTION_TOOL_NAME || !calls[0]?.input) {
        throw new Error(`[graph-memory] Anthropic LLM must call ${GRAPH_EXTRACTION_TOOL_NAME} exactly once`);
    }
    return JSON.stringify(calls[0].input);
}
// ─── 带重试+超时的 fetch ─────────────────────────────────────
const RETRYABLE = new Set([429, 500, 502, 503, 529]);
async function fetchRetry(url, init, retries = 3, timeoutMs = 30_000) {
    for (let i = 0; i <= retries; i++) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(url, { ...init, signal: ctrl.signal });
            clearTimeout(t);
            if (res.ok || i >= retries || !RETRYABLE.has(res.status))
                return res;
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
        }
        catch (err) {
            clearTimeout(t);
            if (i >= retries)
                throw err;
            await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }
    }
    throw new Error("[graph-memory] fetch failed after retries");
}
// ─── CompleteFn 工厂 ────────────────────────────────────────
export function createCompleteFn(provider, model, llmConfig, anthropicApiKey) {
    const guard = new LlmFailureGuard();
    return async (system, user) => {
        if (!guard.canRun()) {
            const seconds = Math.max(1, Math.ceil(guard.remainingMs() / 1000));
            throw new Error(`[graph-memory] LLM paused for ${seconds}s after a previous permanent API error`);
        }
        try {
            // ── 路径 A（优先）：pluginConfig.llm 直接调 OpenAI 兼容 API ──
            const configuredBaseURL = llmConfig?.baseURL ?? llmConfig?.baseUrl;
            if (configuredBaseURL) {
                const config = llmConfig;
                const baseURL = configuredBaseURL.replace(/\/+$/, "");
                const llmModel = config.model ?? model;
                const res = await fetchRetry(`${baseURL}/chat/completions`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        ...(config.apiKey ? { "Authorization": `Bearer ${config.apiKey}` } : {}),
                    },
                    body: JSON.stringify({
                        model: llmModel,
                        messages: [
                            ...(system.trim() ? [{ role: "system", content: system.trim() }] : []),
                            { role: "user", content: user },
                        ],
                        tools: [{
                                type: "function",
                                function: {
                                    name: GRAPH_EXTRACTION_TOOL.name,
                                    description: GRAPH_EXTRACTION_TOOL.description,
                                    parameters: GRAPH_EXTRACTION_TOOL.parameters,
                                },
                            }],
                        tool_choice: {
                            type: "function",
                            function: { name: GRAPH_EXTRACTION_TOOL_NAME },
                        },
                        temperature: 0.1,
                    }),
                });
                if (!res.ok) {
                    const errText = await res.text().catch(() => "");
                    throw new Error(`[graph-memory] LLM API ${res.status}: ${errText.slice(0, 200)}`);
                }
                const data = await res.json();
                const text = openAiStructuredArguments(data);
                guard.reset();
                return text;
            }
            // ── 路径 B：Anthropic API ──────────────────────────────
            if (!anthropicApiKey) {
                throw new Error("[graph-memory] No LLM available. 在 openclaw.json 的 graph-memory config 中配置 llm.baseURL（远程服务同时配置 apiKey）");
            }
            const maxTokens = llmConfig?.maxTokens;
            if (!Number.isInteger(maxTokens) || Number(maxTokens) < 1) {
                throw new Error("[graph-memory] llm.maxTokens must be a positive integer for direct Anthropic API calls");
            }
            const res = await fetchRetry("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-api-key": anthropicApiKey, "anthropic-version": "2023-06-01" },
                body: JSON.stringify({
                    model: llmConfig?.model ?? model,
                    max_tokens: maxTokens,
                    system,
                    messages: [{ role: "user", content: user }],
                    tools: [{
                            name: GRAPH_EXTRACTION_TOOL.name,
                            description: GRAPH_EXTRACTION_TOOL.description,
                            input_schema: GRAPH_EXTRACTION_TOOL.parameters,
                        }],
                    tool_choice: { type: "tool", name: GRAPH_EXTRACTION_TOOL_NAME },
                }),
            });
            if (!res.ok)
                throw new Error(`[graph-memory] Anthropic API ${res.status}`);
            const data = await res.json();
            const text = anthropicStructuredArguments(data);
            guard.reset();
            return text;
        }
        catch (error) {
            if (guard.tripIfNeeded(error)) {
                const seconds = Math.max(1, Math.ceil(guard.remainingMs() / 1000));
                throw new Error(`${String(error)}; pausing graph-memory LLM calls for ${seconds}s`);
            }
            throw error;
        }
    };
}
