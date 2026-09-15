/**
 * graph-memory-pro — Embedding 服务
 *
 * 可选模块：配了 embedding.apiKey（或本地 baseURL）才启用，否则返回 null → 降级 Neo4j 文本搜索
 *
 * 兼容 OpenAI、阿里云 DashScope、MiniMax (MiniMax CodePlan)、Jina、Ollama、llama.cpp 等。
 *
 * MiniMax (MiniMax CodePlan) 是特例：
 *   - 端点走 anthropic 协议但 embeddings 用 OpenAI 风格变体
 *   - 请求体用 `texts: [...]` + `type: "db" | "query"`（不走 OpenAI 的 `input`）
 *   - 响应字段是 `data[0].vector`（不是 `data[0].embedding`）
 *   - 维度固定 1536，不接受 `dimensions` 参数
 *
 * 内置 429/5xx 重试 3 次 + 10s 超时
 */

import type { EmbeddingConfig } from "../types.ts";
import { fetchRetry, throwForStatus } from "./http.ts";

export type EmbedMode = "db" | "query";
export type EmbedFn = (text: string, mode?: EmbedMode) => Promise<number[]>;
export type EmbedBatchFn = (texts: string[], mode?: EmbedMode) => Promise<number[][]>;

export interface Embedder {
  embed: EmbedFn;
  embedBatch: EmbedBatchFn;
}

// ─── Provider 识别 ───────────────────────────────────────────

/**
 * 识别 MiniMax CodePlan 端点。
 * 海外 minimax.io 国内打不开，所以 baseURL 主要是 api.minimaxi.com / minimax.chat。
 */
export function isMinimaxEndpoint(baseURL: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(baseURL).hostname.toLowerCase();
  } catch {
    try {
      hostname = new URL(`https://${baseURL}`).hostname.toLowerCase();
    } catch {
      return false;
    }
  }

  return ["minimaxi.com", "minimax.chat", "minimax.io"].some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

// ─── 批量响应解析（纯函数，可测） ─────────────────────────────

/**
 * 从 /embeddings 响应的 data 数组重建与输入等长、顺序一致的向量数组。
 * OpenAI 兼容端点按 item.index 归位；缺 index 时按响应位置对齐。
 * MiniMax 用 item.vector 字段。条数不符 / 缺向量 / index 非法都抛错——
 * 上层（CLI 重嵌入）会退化为逐条请求兜底。
 */
export function parseBatchEmbeddingResponse(
  data: unknown,
  expectedCount: number,
  minimax: boolean,
): number[][] {
  if (!Array.isArray(data)) {
    throw new Error("[graph-memory-pro] Embedding batch response missing data array");
  }
  if (data.length !== expectedCount) {
    throw new Error(
      `[graph-memory-pro] Embedding batch returned ${data.length} vectors for ${expectedCount} inputs`,
    );
  }
  const out: number[][] = new Array(expectedCount);
  data.forEach((item: any, position: number) => {
    const vec = minimax ? item?.vector : item?.embedding;
    if (!Array.isArray(vec) || !vec.length) {
      throw new Error(`[graph-memory-pro] Embedding batch response item ${position} has no vector`);
    }
    const index = typeof item?.index === "number" ? item.index : position;
    if (index < 0 || index >= expectedCount || out[index]) {
      throw new Error(`[graph-memory-pro] Embedding batch response has invalid index ${index}`);
    }
    out[index] = vec;
  });
  return out;
}

// ─── EmbedFn 工厂 ───────────────────────────────────────────

/**
 * 构造单发 + 批量两个 embed 函数（共享 probe 与配置解析）。
 * 运行时路径只用单发 embed；`graph-memory reembed` 额外消费批量接口。
 */
export async function createEmbedder(cfg: EmbeddingConfig | undefined): Promise<Embedder | null> {
  // Local OpenAI-compatible servers commonly do not require a key. A key by
  // itself still selects the default OpenAI endpoint; a URL by itself selects
  // an unauthenticated local/custom endpoint.
  if (!cfg || (!cfg.apiKey && !cfg.baseURL)) return null;
  // Bind to a non-optional local so TS narrows it inside the callEmbedding closure.
  const config: EmbeddingConfig = cfg;

  const baseURL    = (config.baseURL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const model      = config.model ?? "text-embedding-3-small";
  const dimensions = config.dimensions && config.dimensions > 0 ? config.dimensions : undefined;
  const minimax    = isMinimaxEndpoint(baseURL);
  const apiKey     = config.apiKey;

  /**
   * 构造请求 body。MiniMax 走 texts+type 分支，其他 OpenAI 兼容端点维持原行为。
   * type: db=入库, query=查询（MiniMax 内部用不同模型）
   * 批量时 input 为 string[]：标准端点直接传数组，MiniMax 的 texts 本就是数组。
   */
  function buildBody(input: string | string[], mode: EmbedMode): Record<string, unknown> {
    if (minimax) {
      return {
        model,
        texts: Array.isArray(input) ? input : [input],
        type: mode,
      };
    }
    const body: Record<string, unknown> = { model, input };
    if (dimensions) body.dimensions = dimensions;
    return body;
  }

  async function postEmbedding(body: Record<string, unknown>, timeoutMs: number): Promise<Response> {
    return fetchRetry(`${baseURL}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    }, { timeoutMs, label: "[graph-memory-pro] Embedding", retryOnTimeout: true });
  }

  async function callEmbedding(input: string, mode: EmbedMode): Promise<number[]> {
    const res = await postEmbedding(buildBody(input, mode), 10_000);

    if (!res.ok) {
      await throwForStatus(res, "[graph-memory-pro] Embedding API");
    }

    const data = await res.json() as any;
    const item = data?.data?.[0];
    const embedding: number[] | undefined = minimax ? item?.vector : item?.embedding;
    if (!Array.isArray(embedding) || !embedding.length) {
      throw new Error("[graph-memory-pro] Embedding API returned empty embedding");
    }
    return embedding;
  }

  async function callEmbeddingBatch(texts: string[], mode: EmbedMode): Promise<number[][]> {
    if (!texts.length) return [];
    // 批量请求服务端耗时随条数线性增长：按 2s/条 推算超时，下限沿用单发的 10s
    const res = await postEmbedding(buildBody(texts, mode), Math.max(10_000, 2_000 * texts.length));

    if (!res.ok) {
      await throwForStatus(res, "[graph-memory-pro] Embedding API");
    }

    const data = await res.json() as any;
    return parseBatchEmbeddingResponse(data?.data, texts.length, minimax);
  }

  try {
    const probe = await callEmbedding("ping", "query");
    if (!probe.length) return null;

    return {
      embed: async (text: string, mode: EmbedMode = "db"): Promise<number[]> => {
        return callEmbedding(text.slice(0, 8000), mode);
      },
      embedBatch: async (texts: string[], mode: EmbedMode = "db"): Promise<number[][]> => {
        return callEmbeddingBatch(texts.map(t => t.slice(0, 8000)), mode);
      },
    };
  } catch {
    // probe 失败返回 null（调用方日志已有 "text search mode" 降级提示），不在库代码里写 stdout
    return null;
  }
}
