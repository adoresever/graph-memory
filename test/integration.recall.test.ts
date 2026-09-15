/**
 * recaller 集成测试 — 移植自原 test/recall-*.test.ts
 *
 * 覆盖：Recaller.recall 双路径（precise + generalized）+
 *       syncEmbed hash-based 跳过逻辑
 *
 * 运行：NEO4J_INTEGRATION=1 npm test -- test/integration.recall.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Driver } from "neo4j-driver";
import { getDriver, initSchema, closeDriver, getSession } from "../src/store/db.ts";
import {
  upsertNode, upsertEdge, saveVector, getVectorHash,
} from "../src/store/store.ts";
import { Recaller, buildNodeEmbeddingText } from "../src/recaller/recall.ts";
import { DEFAULT_CONFIG, type GmConfig } from "../src/types.ts";

const ENABLED = !!process.env.NEO4J_INTEGRATION;
const NEO4J_URI = process.env.NEO4J_TEST_URI ?? "bolt://localhost:7687";

let driver: Driver;
const TEST_SID = `recall-${Date.now()}`;
const cfg: GmConfig = { ...DEFAULT_CONFIG, recallMaxNodes: 5, recallMaxDepth: 2 };

describe.skipIf(!ENABLED)("Recaller integration", () => {
  beforeAll(async () => {
    driver = getDriver({ uri: NEO4J_URI, user: "neo4j", password: "graphmemory" });
    await initSchema(driver);

    // 构造可被关键词召回的图
    const { node: skill } = await upsertNode(driver, {
      type: "SKILL", name: "recall-target-skill",
      description: "docker compose deployment",
      content: "docker compose up -d for deployment",
    }, TEST_SID);
    const { node: task } = await upsertNode(driver, {
      type: "TASK", name: "recall-target-task",
      description: "deploy with docker",
      content: "use docker to deploy",
    }, TEST_SID);
    await upsertEdge(driver, {
      fromId: task.id, toId: skill.id, type: "USED_SKILL",
      instruction: "deploys with", sessionId: TEST_SID,
    });
  }, 60000);

  afterAll(async () => {
    const session = getSession(driver);
    try {
      await session.run("MATCH (n) WHERE $sid IN n.sourceSessions DETACH DELETE n", { sid: TEST_SID });
    } finally {
      await session.close();
    }
    await closeDriver();
  }, 30000);

  it("recall 不带 embedFn：降级到 searchNodes 路径，返回合法结构", async () => {
    const recaller = new Recaller(driver, cfg);

    const result = await recaller.recall("docker deploy");

    // 结构验证（不依赖具体节点返回 —— PPR 排序受共享 Neo4j 现有数据影响）
    expect(result).toHaveProperty("nodes");
    expect(result).toHaveProperty("edges");
    expect(Array.isArray(result.nodes)).toBe(true);
    expect(Array.isArray(result.edges)).toBe(true);
  });

  it("recall 带 mock embedFn：走向量搜索路径，不抛错", async () => {
    // mock embed 返回固定向量（触发向量搜索路径，不依赖真实匹配）
    const dim = 1024;
    const mockEmbed = async (_text: string): Promise<number[]> => {
      return new Array(dim).fill(0).map((_, i) => (i % 7) / 7);
    };

    const recaller = new Recaller(driver, cfg);
    recaller.setEmbedFn(mockEmbed);

    // 不抛错即通过（向量维度不匹配时 recallPrecise 内部 try/catch 会 fallback）
    const result = await recaller.recall("docker");
    expect(result).toHaveProperty("nodes");
    expect(result).toHaveProperty("edges");
  });

  it("recall 空查询：降级到 topNodes，返回合法结构", async () => {
    const recaller = new Recaller(driver, cfg);
    const result = await recaller.recall("   ");
    expect(result).toHaveProperty("nodes");
    expect(result).toHaveProperty("edges");
    expect(result.nodes.length).toBeGreaterThanOrEqual(0);
  });

  it("syncEmbed：无 embedFn 时静默跳过（不抛错）", async () => {
    const recaller = new Recaller(driver, cfg);
    const { node } = await upsertNode(driver, {
      type: "SKILL", name: "syncembed-noop-target", description: "x", content: "y",
    }, TEST_SID);
    // 不调 setEmbedFn → this.embed 是 null → syncEmbed 立即 return
    await expect(recaller.syncEmbed(node)).resolves.toBeUndefined();
  });

  it("syncEmbed：内容 hash 与已存一致时跳过 saveVector", async () => {
    const { node } = await upsertNode(driver, {
      type: "SKILL", name: "syncembed-hash-target", description: "hash test", content: "stable content",
    }, TEST_SID);

    // 先写入向量
    const initialVec = new Array(1024).fill(0).map((_, i) => Math.cos(i * 0.05));
    await saveVector(driver, node.id, buildNodeEmbeddingText(node), initialVec);
    const hashBefore = await getVectorHash(driver, node.id);
    expect(hashBefore).not.toBeNull();

    // syncEmbed 用相同 content 计算 hash，应与已存一致 → 跳过 saveVector
    let embedCalled = false;
    const trackingEmbed = async (_text: string): Promise<number[]> => {
      embedCalled = true;
      return new Array(1024).fill(0.5);
    };

    const recaller = new Recaller(driver, cfg);
    recaller.setEmbedFn(trackingEmbed);
    await recaller.syncEmbed(node);

    // hash 一致 → 不会调用 embed（saveVector 不会触发）
    expect(embedCalled).toBe(false);

    // 验证向量未被覆盖
    const hashAfter = await getVectorHash(driver, node.id);
    expect(hashAfter).toBe(hashBefore);
  });

  it("syncEmbed：内容变化时 hash 不同 → 触发 embed + saveVector", async () => {
    const { node } = await upsertNode(driver, {
      type: "SKILL", name: "syncembed-change-target",
      description: "will change", content: "old content",
    }, TEST_SID);

    const oldVec = new Array(1024).fill(0).map((_, i) => Math.sin(i * 0.1));
    await saveVector(driver, node.id, "old content", oldVec);

    // 模拟节点内容已变化（直接 fetch 后改 content，再 syncEmbed）
    const refetched = { ...node, content: "completely new content after change" };

    let embedCalled = false;
    const trackingEmbed = async (_text: string): Promise<number[]> => {
      embedCalled = true;
      return new Array(1024).fill(0.7);
    };

    const recaller = new Recaller(driver, cfg);
    recaller.setEmbedFn(trackingEmbed);
    await recaller.syncEmbed(refetched);

    expect(embedCalled).toBe(true);
  });

  it("syncEmbed：仅 description 变化也会刷新 embedding", async () => {
    const { node } = await upsertNode(driver, {
      type: "SKILL", name: "syncembed-description-target",
      description: "old description", content: "stable content",
    }, TEST_SID);

    const initialVec = new Array(1024).fill(0.25);
    await saveVector(driver, node.id, buildNodeEmbeddingText(node), initialVec);

    let embeddedText = "";
    const recaller = new Recaller(driver, cfg);
    recaller.setEmbedFn(async (text) => {
      embeddedText = text;
      return new Array(1024).fill(0.75);
    });

    await recaller.syncEmbed({ ...node, description: "new description" });
    expect(embeddedText).toContain("new description");
  });

  it("syncEmbedBatch：批量一次往返 + contentHash 短路 + 分块 + 单发回退", async () => {
    // 40 个节点 > SYNC_EMBED_BATCH(32) → 应拆 2 块
    const nodes = [];
    for (let i = 0; i < 40; i++) {
      const { node } = await upsertNode(driver, {
        type: "SKILL", name: `syncembed-batch-target-${i}`,
        description: `batch ${i}`, content: `content ${i}`,
      }, TEST_SID);
      nodes.push(node);
    }

    let batchCalls = 0;
    let singleCalls = 0;
    let totalTexts = 0;
    const recaller = new Recaller(driver, cfg);
    recaller.setEmbedFn(async () => {
      singleCalls++;
      return new Array(1024).fill(0.1);
    });
    recaller.setEmbedBatchFn(async (texts) => {
      batchCalls++;
      totalTexts += texts.length;
      return texts.map(() => new Array(1024).fill(0.2));
    });

    await recaller.syncEmbedBatch(nodes);
    expect(batchCalls).toBe(2);      // 32 + 8 两块
    expect(totalTexts).toBe(40);
    expect(singleCalls).toBe(0);     // 有批量能力时不走单发

    // contentHash 短路：内容未变 → 零新调用
    await recaller.syncEmbedBatch(nodes);
    expect(batchCalls).toBe(2);
    expect(totalTexts).toBe(40);

    // 单节点内容变化 → 只有该节点重嵌入（1 块 1 条文本）
    await recaller.syncEmbedBatch([{ ...nodes[0], content: "changed content after batch" }]);
    expect(batchCalls).toBe(3);
    expect(totalTexts).toBe(41);

    // 旧接线（仅 setEmbedFn）回退到逐节点单发
    const recaller2 = new Recaller(driver, cfg);
    let single2 = 0;
    recaller2.setEmbedFn(async () => {
      single2++;
      return new Array(1024).fill(0.3);
    });
    const { node: fb } = await upsertNode(driver, {
      type: "SKILL", name: "syncembed-batch-fallback",
      description: "f", content: "fallback content",
    }, TEST_SID);
    await recaller2.syncEmbedBatch([fb]);
    expect(single2).toBe(1);

    // 空输入 no-op
    await recaller.syncEmbedBatch([]);
    expect(batchCalls).toBe(3);
  });
});
