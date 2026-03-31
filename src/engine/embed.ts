/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

/**
 * Embedding 服务
 *
 * 可选模块：配了 embedding.apiKey 才启用，否则返回 null → 降级 FTS5
 *
 * 使用 fetch 直接调 OpenAI 兼容 /embeddings 接口（不依赖 openai SDK），
 * 兼容 OpenAI、阿里云 DashScope、MiniMax、Jina、Ollama、llama.cpp 等。
 *
 * 内置：429/5xx 重试 3 次 + 10s 超时
 */

import type { EmbeddingConfig } from "../types.ts";

export type EmbedFn = (text: string) => Promise<number[]>;

// ─── 带重试+超时的 fetch ─────────────────────────────────────

const RETRYABLE = new Set([429, 500, 502, 503, 529]);

async function fetchRetry(url: string, init: RequestInit, retries = 3, timeoutMs = 10_000): Promise<Response> {
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
  throw new Error("[graph-memory] embed fetch failed after retries");
}

// ─── EmbedFn 工厂 ───────────────────────────────────────────

export async function createEmbedFn(cfg: EmbeddingConfig | undefined): Promise<EmbedFn | null> {
  if (!cfg?.apiKey) return null;

  const baseURL    = (cfg.baseURL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const model      = cfg.model ?? "text-embedding-3-small";
  const dimensions = cfg.dimensions && cfg.dimensions > 0 ? cfg.dimensions : undefined;

  function buildBody(input: string): Record<string, unknown> {
    const body: Record<string, unknown> = { model, input };
    if (dimensions) body.dimensions = dimensions;
    return body;
  }

  async function callEmbedding(input: string): Promise<number[]> {
    const res = await fetchRetry(`${baseURL}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${cfg!.apiKey}`,
      },
      body: JSON.stringify(buildBody(input)),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`[graph-memory] Embedding API ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json() as any;
    const embedding = data?.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || !embedding.length) {
      throw new Error("[graph-memory] Embedding API returned empty embedding");
    }
    return embedding;
  }

  // ── 验证连通性 ────────────────────────────────────────────
  try {
    const probe = await callEmbedding("ping");
    if (!probe.length) return null;

    return async (text: string): Promise<number[]> => {
      return callEmbedding(text.slice(0, 8000));
    };
  } catch (err) {
    console.error(`[graph-memory] embedding probe failed:`, err);
    return null;
  }
}