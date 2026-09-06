/**
 * graph-memory — 重嵌入管线纯逻辑单元测试
 *
 * 覆盖 `graph-memory reembed` 的两个可纯测组件：
 * - planReembed：模型输出维度 vs 向量索引维度对照后的行动决策
 * - parseBatchEmbeddingResponse：批量 /embeddings 响应 → 与输入对齐的向量数组
 *   （OpenAI 按 index 归位 / 缺 index 按位置对齐 / MiniMax vector 字段 / 各类异常）
 */

import { describe, it, expect } from "vitest";
import { parseBatchEmbeddingResponse } from "../src/engine/embed.ts";
import { planReembed } from "../src/cli-reembed.ts";

function vec(v: number): number[] {
  return [v, v + 0.5, v + 1];
}

describe("planReembed 维度对照决策", () => {
  it("模型维度与两个索引一致：直接运行", () => {
    expect(planReembed({ probeDim: 1024, nodeIndexDim: 1024, communityIndexDim: 1024 }))
      .toEqual({ action: "run" });
  });

  it("索引不存在（全新库）：initSchema 已按配置建好，直接运行", () => {
    expect(planReembed({ probeDim: 1536, nodeIndexDim: null, communityIndexDim: null }))
      .toEqual({ action: "run" });
  });

  it("维度不一致且无 --recreate-index：中止并给出可操作的指引", () => {
    const plan = planReembed({ probeDim: 1536, nodeIndexDim: 1024, communityIndexDim: 1024 });
    expect(plan.action).toBe("abort");
    if (plan.action === "abort") {
      expect(plan.reason).toContain("1024");
      expect(plan.reason).toContain("1536");
      expect(plan.reason).toContain("--recreate-index");
    }
  });

  it("维度不一致且带 --recreate-index：重建索引", () => {
    const plan = planReembed({ probeDim: 1536, nodeIndexDim: 1024, communityIndexDim: 1024, recreateIndex: true });
    expect(plan).toMatchObject({ action: "recreate-index" });
  });

  it("两个索引维度不一致时按异常集合报告（去重）", () => {
    const plan = planReembed({ probeDim: 512, nodeIndexDim: 1024, communityIndexDim: 768 });
    expect(plan.action).toBe("abort");
    if (plan.action === "abort") {
      expect(plan.reason).toContain("1024/768");
    }
  });

  it("只有一个索引存在且维度匹配：运行", () => {
    expect(planReembed({ probeDim: 1024, nodeIndexDim: 1024, communityIndexDim: null }))
      .toEqual({ action: "run" });
  });
});

describe("parseBatchEmbeddingResponse 批量响应解析", () => {
  it("OpenAI 风格：按 item.index 归位，响应乱序也能对齐输入", () => {
    const data = [
      { index: 2, embedding: vec(3) },
      { index: 0, embedding: vec(1) },
      { index: 1, embedding: vec(2) },
    ];
    expect(parseBatchEmbeddingResponse(data, 3, false)).toEqual([vec(1), vec(2), vec(3)]);
  });

  it("缺 index 字段（部分本地端点）：按响应位置对齐", () => {
    const data = [{ embedding: vec(1) }, { embedding: vec(2) }];
    expect(parseBatchEmbeddingResponse(data, 2, false)).toEqual([vec(1), vec(2)]);
  });

  it("MiniMax 风格：读 item.vector 字段", () => {
    const data = [{ vector: vec(1) }, { vector: vec(2) }];
    expect(parseBatchEmbeddingResponse(data, 2, true)).toEqual([vec(1), vec(2)]);
  });

  it("data 不是数组：抛错", () => {
    expect(() => parseBatchEmbeddingResponse(null, 2, false)).toThrow("missing data array");
    expect(() => parseBatchEmbeddingResponse({ embeddings: [] }, 2, false)).toThrow("missing data array");
  });

  it("返回条数与输入不符：抛错（上层退化逐条兜底）", () => {
    expect(() => parseBatchEmbeddingResponse([{ embedding: vec(1) }], 2, false))
      .toThrow("returned 1 vectors for 2 inputs");
  });

  it("某项缺向量字段：抛错并指明位置", () => {
    expect(() => parseBatchEmbeddingResponse([{ embedding: vec(1) }, { embedding: [] }], 2, false))
      .toThrow("item 1 has no vector");
  });

  it("index 越界或重复：抛错", () => {
    expect(() => parseBatchEmbeddingResponse(
      [{ index: 0, embedding: vec(1) }, { index: 0, embedding: vec(2) }], 2, false,
    )).toThrow("invalid index 0");
    expect(() => parseBatchEmbeddingResponse(
      [{ index: 5, embedding: vec(1) }, { index: 6, embedding: vec(2) }], 2, false,
    )).toThrow("invalid index 5");
  });

  it("空输入：返回空数组（无需请求）", () => {
    expect(parseBatchEmbeddingResponse([], 0, false)).toEqual([]);
  });
});
