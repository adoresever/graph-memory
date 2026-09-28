/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */
// ─── 带重试+超时的 fetch ─────────────────────────────────────
const RETRYABLE = new Set([429, 500, 502, 503, 529]);
async function fetchRetry(url, init, retries = 3, timeoutMs = 10_000) {
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
    throw new Error("[graph-memory] embed fetch failed after retries");
}
// ─── Provider 识别 ───────────────────────────────────────────
/**
 * 识别 MiniMax CodePlan 端点。
 * 海外 minimax.io 国内打不开，所以 baseURL 主要是 api.minimaxi.com / minimax.chat。
 */
export function isMinimaxEndpoint(baseURL) {
    let hostname;
    try {
        hostname = new URL(baseURL).hostname.toLowerCase();
    }
    catch {
        try {
            hostname = new URL(`https://${baseURL}`).hostname.toLowerCase();
        }
        catch {
            return false;
        }
    }
    return ["minimaxi.com", "minimax.chat", "minimax.io"].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}
// ─── EmbedFn 工厂 ───────────────────────────────────────────
export async function createEmbedFn(cfg) {
    // Local OpenAI-compatible servers commonly do not require a key. A key by
    // itself still selects the default OpenAI endpoint; a URL by itself selects
    // an unauthenticated local/custom endpoint.
    if (!cfg || (!cfg.apiKey && !cfg.apiKeyResolver && !cfg.baseURL && !cfg.baseUrl))
        return null;
    const config = cfg;
    const baseURL = (config.baseURL ?? config.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const model = config.model ?? "text-embedding-3-small";
    const dimensions = config.dimensions && config.dimensions > 0 ? config.dimensions : undefined;
    const minimax = isMinimaxEndpoint(baseURL);
    /**
     * 构造请求 body。MiniMax 走 texts+type 分支，其他 OpenAI 兼容端点维持原行为。
     * type: db=入库, query=查询（MiniMax 内部用不同模型）
     */
    function buildBody(input, mode) {
        if (minimax) {
            return {
                model,
                texts: [input],
                type: mode, // "db" | "query"
                // MiniMax 不接受 dimensions
            };
        }
        const body = { model, input };
        if (dimensions)
            body.dimensions = dimensions;
        return body;
    }
    async function callEmbedding(input, mode) {
        const apiKey = config.apiKeyResolver ? await config.apiKeyResolver() : config.apiKey;
        const res = await fetchRetry(`${baseURL}/embeddings`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify(buildBody(input, mode)),
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => "");
            throw new Error(`[graph-memory] Embedding API ${res.status}: ${errText.slice(0, 200)}`);
        }
        const data = await res.json();
        // MiniMax: data[0].vector；OpenAI 兼容: data[0].embedding
        const item = data?.data?.[0];
        const embedding = minimax ? item?.vector : item?.embedding;
        if (!Array.isArray(embedding) || !embedding.length) {
            throw new Error("[graph-memory] Embedding API returned empty embedding");
        }
        return embedding;
    }
    // ── 验证连通性 ────────────────────────────────────────────
    try {
        const probe = await callEmbedding("ping", "query");
        if (!probe.length)
            return null;
        return async (text, mode = "db") => {
            return callEmbedding(text, mode);
        };
    }
    catch (err) {
        console.error(`[graph-memory] embedding probe failed:`, err);
        return null;
    }
}
