/**
 * persistExtractionResult 单测 — 提取结果持久化单一来源
 *
 * 覆盖：
 *   - updatedExisting 统计（isNew=false 的 upsert 命中 → finalize 阶梯第二触发条件的信号源）
 *   - 边端点解析的 Map-first 顺序：nameToId 命中时零 findByName 往返
 *   - nameToId 未命中时回源 findByName（键是规范化名，LLM 原文未必规范化）
 *   - awaitEmbedSync 开关（CLI 必须等待 vs 运行时 fire-and-forget）
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upsertNode: vi.fn(),
  upsertEdge: vi.fn(async () => true),
  // 返回类型放宽为 any：用例会分别模拟 null（未命中）与节点对象（回源命中）
  findByName: vi.fn(async (_d: unknown, _name: unknown): Promise<any> => null),
}));

vi.mock("../src/store/store.ts", () => ({
  upsertNode: mocks.upsertNode,
  upsertEdge: mocks.upsertEdge,
  findByName: mocks.findByName,
}));

import { persistExtractionResult } from "../src/extractor/persist.ts";

function mkNode(name: string) {
  return {
    id: `n-${name}`,
    type: "SKILL" as const,
    name,
    description: "d",
    content: "c",
    status: "active" as const,
    validatedCount: 1,
    sourceSessions: [] as string[],
    communityId: null,
    pagerank: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

const recaller = { syncEmbedBatch: async () => {} };
const driver = {} as any;

describe("persistExtractionResult", () => {
  beforeEach(() => {
    mocks.upsertNode.mockReset();
    mocks.upsertEdge.mockReset();
    mocks.findByName.mockReset();
    mocks.upsertEdge.mockResolvedValue(true);
    mocks.findByName.mockResolvedValue(null);
  });

  it("统计 updatedExisting：isNew=false 的 upsert 计入，isNew=true 不计", async () => {
    mocks.upsertNode
      .mockResolvedValueOnce({ node: mkNode("fresh-node"), isNew: true })
      .mockResolvedValueOnce({ node: mkNode("existing-node"), isNew: false });

    const outcome = await persistExtractionResult(driver, recaller, {
      nodes: [
        { type: "TASK", name: "fresh-node", description: "d", content: "c" },
        { type: "SKILL", name: "existing-node", description: "d", content: "c" },
      ],
      edges: [],
    }, { sessionId: "s1" });

    expect(outcome.nodes).toHaveLength(2);
    expect(outcome.updatedExisting).toBe(1);
    expect(outcome.edges).toBe(0);
  });

  it("边端点优先查 nameToId：命中时零 findByName 往返", async () => {
    mocks.upsertNode.mockResolvedValue({ node: mkNode("deploy-task"), isNew: true });

    const outcome = await persistExtractionResult(driver, recaller, {
      nodes: [{ type: "TASK", name: "deploy-task", description: "d", content: "c" }],
      edges: [
        { from: "deploy-task", to: "deploy-task", type: "USED_SKILL", instruction: "self" },
        { from: "deploy-task", to: "missing", type: "USED_SKILL", instruction: "unresolved" },
      ],
    }, { sessionId: "s2" });

    expect(outcome.edges).toBe(1);
    // from 命中索引；to 未命中且 findByName 返回 null → 该边被丢弃
    expect(mocks.findByName).toHaveBeenCalledTimes(1);
    expect(mocks.findByName).toHaveBeenCalledWith(driver, "missing");
  });

  it("nameToId 未命中时回源 findByName（LLM 原文未必是规范化名）", async () => {
    mocks.upsertNode.mockResolvedValue({ node: mkNode("skill-b"), isNew: true });
    mocks.findByName.mockResolvedValueOnce(mkNode("skill-b"));

    const outcome = await persistExtractionResult(driver, recaller, {
      nodes: [{ type: "SKILL", name: "skill-b", description: "d", content: "c" }],
      edges: [{ from: "Skill B", to: "skill-b", type: "REQUIRES", instruction: "i" }],
    }, { sessionId: "s3" });

    // from="Skill B" 未命中索引 → 回源 1 次；to="skill-b" 命中索引 → 零往返
    expect(mocks.findByName).toHaveBeenCalledTimes(1);
    expect(mocks.findByName).toHaveBeenCalledWith(driver, "Skill B");
    expect(outcome.edges).toBe(1);
  });

  it("awaitEmbedSync=true 时等待向量同步完成才返回", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slowRecaller = { syncEmbedBatch: vi.fn(() => gate) };

    mocks.upsertNode.mockResolvedValue({ node: mkNode("n"), isNew: true });

    const pending = persistExtractionResult(driver, slowRecaller, {
      nodes: [{ type: "SKILL", name: "n", description: "d", content: "c" }],
      edges: [],
    }, { sessionId: "s4", awaitEmbedSync: true });

    // 排空微任务让 persist 走到 syncEmbedBatch 调用点（不刷宏任务，保持确定性）
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // 同步已启动但未完成 → persist 仍挂起
    expect(slowRecaller.syncEmbedBatch).toHaveBeenCalledTimes(1);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await pending;
  });

  it("awaitEmbedSync 缺省（运行时路径）时 fire-and-forget：不等待同步即返回", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slowRecaller = { syncEmbedBatch: vi.fn(() => gate) };

    mocks.upsertNode.mockResolvedValue({ node: mkNode("n"), isNew: true });

    // 同步 promise 永不 resolve，persist 仍应正常返回（fire-and-forget）
    const outcome = await persistExtractionResult(driver, slowRecaller, {
      nodes: [{ type: "SKILL", name: "n", description: "d", content: "c" }],
      edges: [],
    }, { sessionId: "s5" });

    expect(slowRecaller.syncEmbedBatch).toHaveBeenCalledTimes(1);
    expect(outcome.nodes).toHaveLength(1);
    release();
    await slowRecaller.syncEmbedBatch.mock.results[0]!.value;
  });
});
