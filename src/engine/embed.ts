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
 * 支持：
 *   OpenAI     baseURL=https://api.openai.com/v1  model=text-embedding-3-small
 *   Ollama     baseURL=http://localhost:11434/v1   model=nomic-embed-text
 *   任意 OpenAI 兼容端点
 */

import type { EmbeddingConfig } from "../types.ts";

export type EmbedFn = (text: string) => Promise<number[]>;

export async function createEmbedFn(cfg: EmbeddingConfig | undefined): Promise<EmbedFn | null> {
  if (!cfg?.apiKey) return null;

  const baseURL    = cfg.baseURL    ?? "https://api.openai.com/v1";
  const model      = cfg.model      ?? "text-embedding-3-small";
  const dimensions = cfg.dimensions ?? 512;

  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: cfg.apiKey, baseURL });

    // 验证连通性
    const probe = await client.embeddings.create({
      model,
      input: "ping",
      ...(dimensions ? { dimensions } : {}),
    });
    if (!probe.data?.[0]?.embedding?.length) return null;

    return async (text: string): Promise<number[]> => {
      const res = await client.embeddings.create({
        model,
        input: text.slice(0, 8000),
        ...(dimensions ? { dimensions } : {}),
      });
      return res.data[0]?.embedding ?? [];
    };
  } catch {
    return null;
  }
}