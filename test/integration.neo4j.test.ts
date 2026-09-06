import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Driver } from "neo4j-driver";
import graphMemoryProPlugin from "../index.ts";
import { getDriver, initSchema, closeDriver, getSession } from "../src/store/db.ts";
import { buildNodeEmbeddingText } from "../src/recaller/recall.ts";
import {
  upsertNode, findByName, findById, updateNode,
  upsertEdge, edgesFrom, edgesTo, graphWalk,
  saveMessage, getUnextracted, markExtracted, isTurnExtracted,
  getStats, mergeNodes, searchNodes, topNodes,
  getBySession, saveVector, vectorSearchWithScore, getVectorHash,
  updateCommunities,
  deprecateNodeAndDisconnect, deprecateNodeAndDisconnectById,
  deleteEdges,
  clearAllEmbeddings, listNodeEmbeddingTargets, listCommunityEmbeddingTargets,
  saveCommunityEmbedding, getVectorIndexDimensions,
  autoDeprecateNodes, purgeDeprecatedNodes,
} from "../src/store/store.ts";
import { applyDecay } from "../src/graph/decay.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

// 仅在 NEO4J_INTEGRATION=1 时运行，避免污染默认 npm test（需要 Docker Neo4j）
const ENABLED = !!process.env.NEO4J_INTEGRATION;
const NEO4J_URI = process.env.NEO4J_TEST_URI ?? "bolt://localhost:7687";

let driver: Driver;
let contextEngine: any;
const TEST_SID = `integration-${Date.now()}`;

async function readMessages(sessionId: string): Promise<Array<{ role: string; content: unknown }>> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      `MATCH (m:GmMessage {sessionId: $sessionId})
       RETURN m.role AS role, m.content AS content
       ORDER BY m.turnIndex`,
      { sessionId },
    );
    return result.records.map((record) => ({
      role: record.get("role"),
      content: JSON.parse(record.get("content")),
    }));
  } finally {
    await session.close();
  }
}

describe.skipIf(!ENABLED)("Neo4j integration (Docker)", () => {
  beforeAll(async () => {
    driver = getDriver({ uri: NEO4J_URI, user: "neo4j", password: "graphmemory" });
    await initSchema(driver);

    const engineFactories: Array<() => any> = [];
    graphMemoryProPlugin.register({
      registrationMode: "full",
      pluginConfig: {
        neo4j: { uri: NEO4J_URI, user: "neo4j", password: "graphmemory" },
        llm: { provider: "oauth", model: "gpt-5", oauthPath: "/nonexistent/graph-memory-test-oauth.json" },
      },
      config: {},
      resolvePath: (value: string) => value,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      on() {},
      registerTool() {},
      registerHttpRoute() {},
      registerCli() {},
      registerContextEngine(_id: string, factory: () => any) {
        engineFactories.push(factory);
      },
    } as any);
    contextEngine = engineFactories[0]?.();
    expect(contextEngine).toBeTruthy();
  }, 60000);

  afterAll(async () => {
    const session = getSession(driver);
    try {
      await session.run("MATCH (n) WHERE $sid IN n.sourceSessions DETACH DELETE n", { sid: TEST_SID });
      await session.run("MATCH (m:GmMessage) WHERE m.sessionId STARTS WITH $sid DELETE m", { sid: TEST_SID });
    } finally {
      await session.close();
    }
    await contextEngine?.dispose?.();
    await closeDriver();
  }, 30000);

  it("upsertNode 创建节点 + findByName 取回（名称标准化）", async () => {
    const { node, isNew } = await upsertNode(driver, {
      type: "SKILL", name: "Docker Build",
      description: "build images", content: "docker build -t name .",
    }, TEST_SID);
    expect(isNew).toBe(true);
    expect(node.name).toBe("docker-build");
    expect(node.type).toBe("SKILL");

    const found = await findByName(driver, "Docker Build");
    expect(found).not.toBeNull();
    expect(found!.id).toBe(node.id);
  });

  it("upsertNode 同名更新（isNew=false，validatedCount 递增）", async () => {
    const { node, isNew } = await upsertNode(driver, {
      type: "SKILL", name: "Docker Build",
      description: "better desc", content: "longer content here",
    }, TEST_SID);
    expect(isNew).toBe(false);
    expect(node.validatedCount).toBeGreaterThanOrEqual(2);
  });

  it("updateNode (#57 移植) 按 name 更新 description/content 并持久化", async () => {
    const updated = await updateNode(driver, "docker-build", {
      description: "refined desc",
      content: "refined content",
    });
    expect(updated).not.toBeNull();
    expect(updated!.description).toBe("refined desc");
    expect(updated!.content).toBe("refined content");
    const refetch = await findByName(driver, "docker-build");
    expect(refetch!.description).toBe("refined desc");
    expect(refetch!.content).toBe("refined content");
  });

  it("updateNode 未知 name 返回 null", async () => {
    expect(await updateNode(driver, "ghost-node-xyz", { description: "x" })).toBeNull();
  });

  it("upsertEdge (APOC) 建边 + edgesFrom 取回", async () => {
    const { node: task } = await upsertNode(driver, {
      type: "TASK", name: "Deploy App", description: "d", content: "c",
    }, TEST_SID);
    const { node: skill } = await upsertNode(driver, {
      type: "SKILL", name: "CI/CD Pipeline", description: "d", content: "c",
    }, TEST_SID);
    await upsertEdge(driver, {
      fromId: task.id, toId: skill.id, type: "USED_SKILL",
      instruction: "uses", sessionId: TEST_SID,
    });
    const edges = await edgesFrom(driver, task.id);
    expect(edges.length).toBeGreaterThanOrEqual(1);
    expect(edges.some(e => e.type === "USED_SKILL" && e.toId === skill.id)).toBe(true);
  });

  it("upsertEdge 幂等：同 from+to+type 不重复创建", async () => {
    const task = await findByName(driver, "deploy-app");
    const skill = await findByName(driver, "cicd-pipeline");
    const before = await edgesFrom(driver, task!.id);
    await upsertEdge(driver, {
      fromId: task!.id, toId: skill!.id, type: "USED_SKILL",
      instruction: "uses v2", sessionId: TEST_SID,
    });
    const after = await edgesFrom(driver, task!.id);
    expect(after.length).toBe(before.length);
    // instruction 应被更新
    expect(after.find(e => e.toId === skill!.id)!.instruction).toBe("uses v2");
  });

  it("edgesTo 反向查询（目标节点收到入边）", async () => {
    const skill = await findByName(driver, "cicd-pipeline");
    const incoming = await edgesTo(driver, skill!.id);
    expect(incoming.length).toBeGreaterThanOrEqual(1);
    expect(incoming.some(e => e.type === "USED_SKILL")).toBe(true);
  });

  it("upsertEdge 在存储层拒绝非法方向和白名单外类型", async () => {
    const task = await findByName(driver, "deploy-app");
    const skill = await findByName(driver, "cicd-pipeline");

    expect(await upsertEdge(driver, {
      fromId: skill!.id, toId: task!.id, type: "USED_SKILL",
      instruction: "wrong direction", sessionId: TEST_SID,
    })).toBe(false);
    expect(await upsertEdge(driver, {
      fromId: skill!.id, toId: skill!.id, type: "ARBITRARY_REL" as any,
      instruction: "unknown type", sessionId: TEST_SID,
    })).toBe(false);
  });

  it("graphWalk 从 seed 遍历到关联节点", async () => {
    const seed = await findByName(driver, "deploy-app");
    expect(seed).not.toBeNull();
    const { nodes, edges } = await graphWalk(driver, [seed!.id], 2);
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes.some(n => n.name === "cicd-pipeline")).toBe(true);
    expect(edges.some(e => e.type === "USED_SKILL")).toBe(true);
  });

  it("graphWalk 不穿过 deprecated 中间节点（弃用同时断联）", async () => {
    const { node: start } = await upsertNode(driver, {
      type: "SKILL", name: "Active Walk Start", description: "start", content: "start",
    }, TEST_SID);
    const { node: deprecatedBridge } = await upsertNode(driver, {
      type: "SKILL", name: "Deprecated Walk Bridge", description: "bridge", content: "bridge",
    }, TEST_SID);
    const { node: unreachable } = await upsertNode(driver, {
      type: "SKILL", name: "Active Walk Unreachable", description: "end", content: "end",
    }, TEST_SID);
    await upsertEdge(driver, {
      fromId: start.id, toId: deprecatedBridge.id, type: "REQUIRES",
      instruction: "first hop", sessionId: TEST_SID,
    });
    await upsertEdge(driver, {
      fromId: deprecatedBridge.id, toId: unreachable.id, type: "REQUIRES",
      instruction: "second hop", sessionId: TEST_SID,
    });
    // 手动弃用（按 id）——同时切断两侧边
    await deprecateNodeAndDisconnectById(driver, deprecatedBridge.id);
    expect(await edgesTo(driver, deprecatedBridge.id)).toHaveLength(0);
    expect(await edgesFrom(driver, deprecatedBridge.id)).toHaveLength(0);

    const { nodes } = await graphWalk(driver, [start.id], 2);

    expect(nodes.map(node => node.id)).not.toContain(unreachable.id);
  });

  it("graphWalk 空种子返回空结果", async () => {
    const { nodes, edges } = await graphWalk(driver, [], 2);
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });

  it("saveMessage + getUnextracted + markExtracted + isTurnExtracted (#1/#2 修复路径)", async () => {
    await saveMessage(driver, TEST_SID, 100, "user", { text: "hello" });
    await saveMessage(driver, TEST_SID, 101, "turn", [{ role: "user", content: "x" }]);

    const before = await getUnextracted(driver, TEST_SID, 10);
    expect(before.length).toBeGreaterThanOrEqual(2);
    expect(await isTurnExtracted(driver, TEST_SID, 100)).toBe(false);

    await markExtracted(driver, TEST_SID, 101);

    expect(await isTurnExtracted(driver, TEST_SID, 100)).toBe(true);
    expect(await isTurnExtracted(driver, TEST_SID, 101)).toBe(true);

    const after = await getUnextracted(driver, TEST_SID, 10);
    expect(after.length).toBe(0);
  });

  it("afterTurn backfills messages when OpenClaw skips ingest (#59)", async () => {
    const sessionId = `${TEST_SID}-after-turn-only`;
    const messages = [
      { role: "user", content: "legacy host user message" },
      { role: "assistant", content: "legacy host assistant message" },
    ];

    await contextEngine.afterTurn({
      sessionId,
      sessionKey: sessionId,
      sessionFile: "",
      messages,
      prePromptMessageCount: 0,
    });

    const stored = await readMessages(sessionId);
    expect(stored).toHaveLength(2);
    expect(stored.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("afterTurn does not duplicate messages already delivered by ingest (#59)", async () => {
    const sessionId = `${TEST_SID}-ingest-and-after-turn`;
    const messages = [
      { role: "user", content: "modern host user message" },
      { role: "assistant", content: "modern host assistant message" },
    ];

    for (const message of messages) {
      await contextEngine.ingest({ sessionId, sessionKey: sessionId, message });
    }
    await contextEngine.afterTurn({
      sessionId,
      sessionKey: sessionId,
      sessionFile: "",
      messages,
      prePromptMessageCount: 0,
    });

    const stored = await readMessages(sessionId);
    expect(stored).toHaveLength(2);
    expect(stored.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("getStats (#9 去除冗余查询后) 返回完整结构", async () => {
    const stats = await getStats(driver);
    expect(stats).toHaveProperty("totalNodes");
    expect(stats).toHaveProperty("byType");
    expect(stats).toHaveProperty("totalEdges");
    expect(stats).toHaveProperty("byEdgeType");
    expect(stats).toHaveProperty("communities");
    expect(typeof stats.totalNodes).toBe("number");
    expect(stats.totalNodes).toBeGreaterThanOrEqual(1);
    expect(stats.byType.SKILL).toBeGreaterThanOrEqual(1);
  });

  it("deprecateNodeAndDisconnectById 手动弃用：断联 + 前缀 + manual 标记（finalize invalidations / REST DELETE 路径）", async () => {
    const { node } = await upsertNode(driver, {
      type: "EVENT", name: "Temp Event", description: "d", content: "c",
    }, TEST_SID);
    const result = await deprecateNodeAndDisconnectById(driver, node.id);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("deprecated");
    expect(result!.deprecatedBy).toBe("manual");
    expect(result!.description).toBe("[DEPRECATED] d");

    const refetch = await findById(driver, node.id);
    expect(refetch).not.toBeNull();
    expect(refetch!.status).toBe("deprecated");
    expect(await deprecateNodeAndDisconnectById(driver, "ghost-node-deprecate-id-xyz")).toBeNull();

    // 重复弃用保留原 deprecatedAt（不重置 purge 时钟）
    const firstAt = refetch!.deprecatedAt!;
    const again = await deprecateNodeAndDisconnectById(driver, node.id, firstAt + 86_400_000);
    expect(again!.deprecatedAt).toBe(firstAt);
    expect((await findById(driver, node.id))!.deprecatedAt).toBe(firstAt);
  });

  it("deprecateNodeAndDisconnect 标记 [DEPRECATED] + 切边（节点保留，gm_update mode=deprecate）", async () => {
    const { node: victim } = await upsertNode(driver, {
      type: "SKILL", name: "DeprecateTarget Skill", description: "原描述", content: "content",
    }, TEST_SID);
    const { node: a } = await upsertNode(driver, {
      type: "TASK", name: "Deprecate Neighbor A", description: "neighbor", content: "neighbor",
    }, TEST_SID);
    const { node: b } = await upsertNode(driver, {
      type: "SKILL", name: "Deprecate Neighbor B", description: "neighbor", content: "neighbor",
    }, TEST_SID);
    await upsertEdge(driver, {
      fromId: a.id, toId: victim.id, type: "USED_SKILL",
      instruction: "uses", sessionId: TEST_SID,
    });
    await upsertEdge(driver, {
      fromId: victim.id, toId: b.id, type: "REQUIRES",
      instruction: "needs", sessionId: TEST_SID,
    });

    const result = await deprecateNodeAndDisconnect(driver, "DeprecateTarget Skill");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("deprecated");
    expect(result!.description).toBe("[DEPRECATED] 原描述");

    const refetch = await findById(driver, victim.id);
    expect(refetch).not.toBeNull();
    expect(refetch!.status).toBe("deprecated");
    expect(refetch!.description).toBe("[DEPRECATED] 原描述");

    const inEdges = await edgesTo(driver, victim.id);
    expect(inEdges).toHaveLength(0);
    const outEdges = await edgesFrom(driver, victim.id);
    expect(outEdges).toHaveLength(0);

    expect((await findById(driver, a.id))!.status).toBe("active");
    expect((await findById(driver, b.id))!.status).toBe("active");
  });

  it("deprecateNodeAndDisconnect 幂等：已带前缀不重复添加", async () => {
    const { node } = await upsertNode(driver, {
      type: "SKILL", name: "Idempotent Deprecate", description: "[DEPRECATED] 已经弃用", content: "c",
    }, TEST_SID);
    const result = await deprecateNodeAndDisconnect(driver, node.name);
    expect(result).not.toBeNull();
    expect(result!.description).toBe("[DEPRECATED] 已经弃用");
  });

  it("deprecateNodeAndDisconnect 未知 name 返回 null", async () => {
    expect(await deprecateNodeAndDisconnect(driver, "ghost-node-deprecate-xyz")).toBeNull();
  });

  it("deleteEdges 按 type 删除：保留其他类型的边（gm_unlink type 过滤）", async () => {
    const { node: a } = await upsertNode(driver, {
      type: "SKILL", name: "Unlink Type A", description: "a", content: "a",
    }, TEST_SID);
    const { node: b } = await upsertNode(driver, {
      type: "SKILL", name: "Unlink Type B", description: "b", content: "b",
    }, TEST_SID);

    await upsertEdge(driver, { fromId: a.id, toId: b.id, type: "REQUIRES", instruction: "needs", sessionId: TEST_SID });
    await upsertEdge(driver, { fromId: a.id, toId: b.id, type: "PATCHES", instruction: "patches", sessionId: TEST_SID });

    const deleted = await deleteEdges(driver, a.id, b.id, "REQUIRES");
    expect(deleted).toBe(1);

    const remaining = await edgesFrom(driver, a.id);
    const abRemaining = remaining.filter(e => e.toId === b.id);
    expect(abRemaining).toHaveLength(1);
    expect(abRemaining[0].type).toBe("PATCHES");
  });

  it("deleteEdges 不带 type：删除 from→to 之间所有边（gm_unlink 全删）", async () => {
    const { node: a } = await upsertNode(driver, {
      type: "SKILL", name: "Unlink All A", description: "a", content: "a",
    }, TEST_SID);
    const { node: b } = await upsertNode(driver, {
      type: "SKILL", name: "Unlink All B", description: "b", content: "b",
    }, TEST_SID);

    await upsertEdge(driver, { fromId: a.id, toId: b.id, type: "REQUIRES", instruction: "x", sessionId: TEST_SID });
    await upsertEdge(driver, { fromId: a.id, toId: b.id, type: "PATCHES", instruction: "y", sessionId: TEST_SID });

    const deleted = await deleteEdges(driver, a.id, b.id);
    expect(deleted).toBe(2);

    const remaining = (await edgesFrom(driver, a.id)).filter(e => e.toId === b.id);
    expect(remaining).toHaveLength(0);
  });

  it("deleteEdges 不存在的边返回 0", async () => {
    const { node: a } = await upsertNode(driver, {
      type: "SKILL", name: "Unlink Empty A", description: "a", content: "a",
    }, TEST_SID);
    const { node: b } = await upsertNode(driver, {
      type: "SKILL", name: "Unlink Empty B", description: "b", content: "b",
    }, TEST_SID);
    const deleted = await deleteEdges(driver, a.id, b.id);
    expect(deleted).toBe(0);
  });

  // ─── SQLite 时代 store 测试意图移植 ─────────────────────────────
  // 以下用例对应原 test/store.test.ts 中被删除的 SQLite 测试场景：
  // 节点合并、向量搜索、社区更新、按 session 查询、关键词搜索

  it("mergeNodes 合并：keep 保留 + merge 标记 deprecated + 入边/出边迁移", async () => {
    // 构造图：a → merge → keep → c （merge 同时有入边和出边）
    const { node: a } = await upsertNode(driver, {
      type: "TASK", name: "Merge Source A", description: "src", content: "src content",
    }, TEST_SID);
    const { node: merge } = await upsertNode(driver, {
      type: "SKILL", name: "Merge Target", description: "will be merged",
      content: "merge-content-longer",
    }, TEST_SID);
    const { node: keep } = await upsertNode(driver, {
      type: "SKILL", name: "Merge Keeper", description: "will keep",
      content: "keep-content",
    }, TEST_SID);
    const { node: c } = await upsertNode(driver, {
      type: "SKILL", name: "Merge Downstream C", description: "downstream", content: "c content",
    }, TEST_SID);

    await upsertEdge(driver, { fromId: a.id, toId: merge.id, type: "USED_SKILL", instruction: "uses", sessionId: TEST_SID });
    await upsertEdge(driver, { fromId: merge.id, toId: c.id, type: "REQUIRES", instruction: "needs", sessionId: TEST_SID });

    const keepValidatedBefore = keep.validatedCount;
    const mergeContentBefore = (await findById(driver, merge.id))!.content;

    await mergeNodes(driver, keep.id, merge.id);

    const keepAfter = await findById(driver, keep.id);
    const mergeAfter = await findById(driver, merge.id);
    expect(keepAfter).not.toBeNull();
    expect(mergeAfter!.status).toBe("deprecated");
    // validatedCount 应累加
    expect(keepAfter!.validatedCount).toBeGreaterThanOrEqual(keepValidatedBefore);
    // content 应取较长的（merge-content-longer > keep-content）
    expect(keepAfter!.content).toBe(mergeContentBefore);

    // 入边迁移：a → merge 现在应是 a → keep
    const aOut = await edgesFrom(driver, a.id);
    expect(aOut.some(e => e.toId === keep.id && e.type === "USED_SKILL")).toBe(true);
    // 出边迁移：merge → c 现在应是 keep → c
    const keepOut = await edgesFrom(driver, keep.id);
    expect(keepOut.some(e => e.toId === c.id && e.type === "REQUIRES")).toBe(true);
  });

  it("saveVector + vectorSearchWithScore + getVectorHash（向量索引可用）", async () => {
    const { node } = await upsertNode(driver, {
      type: "SKILL", name: "Vector Test Skill", description: "v", content: "vector search target",
    }, TEST_SID);

    // 1024 维向量（与 initSchema 默认维度一致）
    const vec = new Array(1024).fill(0).map((_, i) => (i % 10) / 10);
    await saveVector(driver, node.id, "vector search target", vec);

    const hash = await getVectorHash(driver, node.id);
    expect(hash).not.toBeNull();
    expect(hash).toMatch(/^[a-f0-9]{32}$/);

    // 向量搜索（自己搜自己应该排第一）
    const results = await vectorSearchWithScore(driver, vec, 5, 0);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].node.id).toBe(node.id);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("updateCommunities + getBySession + communityRepresentatives", async () => {
    const { node: n1 } = await upsertNode(driver, {
      type: "SKILL", name: "Community Member 1", description: "cm1", content: "c1",
    }, TEST_SID);
    const { node: n2 } = await upsertNode(driver, {
      type: "SKILL", name: "Community Member 2", description: "cm2", content: "c2",
    }, TEST_SID);

    const labels = new Map<string, string>([
      [n1.id, "c-test-1"], [n2.id, "c-test-1"],
    ]);
    await updateCommunities(driver, labels);

    const refetch1 = await findById(driver, n1.id);
    expect(refetch1!.communityId).toBe("c-test-1");

    // getBySession：两个节点都标记了 TEST_SID
    const bySid = await getBySession(driver, TEST_SID);
    const ids = bySid.map(n => n.id);
    expect(ids).toContain(n1.id);
    expect(ids).toContain(n2.id);
  });

  it("searchNodes 关键词模糊匹配 + topNodes 按 pagerank 排序", async () => {
    await upsertNode(driver, {
      type: "SKILL", name: "Kubernetes Deploy Unique Keyword", description: "k8s", content: "kubectl apply",
    }, TEST_SID);
    await upsertNode(driver, {
      type: "SKILL", name: "Another Kubernetes Skill", description: "k8s alt", content: "kubectl get pods",
    }, TEST_SID);

    const hits = await searchNodes(driver, "Kubernetes", 5);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.every(n => n.name.includes("kubernetes") || n.description.includes("k8s") || n.content.includes("kubectl"))).toBe(true);

    // topNodes：直接用 Cypher 写 pagerank（生产由 gds.pageRank.write 写入），再查 top
    const { node: top } = await upsertNode(driver, {
      type: "TASK", name: "Top Ranked Task", description: "high", content: "important",
    }, TEST_SID);
    const w = driver.session();
    try {
      await w.run("MATCH (n:Task|Skill|Event {id: $id}) SET n.pagerank = 999", { id: top.id });
    } finally {
      await w.close();
    }
    const topHits = await topNodes(driver, 3);
    expect(topHits.length).toBeGreaterThanOrEqual(1);
    expect(topHits[0].id).toBe(top.id);
    expect(topHits[0].pagerank).toBeGreaterThanOrEqual(999);
  });

  it("searchNodes 空查询降级到 topNodes", async () => {
    const hits = await searchNodes(driver, "   ", 3);
    expect(hits.length).toBeLessThanOrEqual(3);
  });

  it("重嵌入管线：clearAllEmbeddings + listNodeEmbeddingTargets 游标分页 + saveVector 回填", async () => {
    const { node } = await upsertNode(driver, {
      type: "SKILL", name: "Reembed Pipeline Skill", description: "re", content: "reembed me",
    }, TEST_SID);

    // 前面用例在同库累积的活动节点已超过单页 limit——断言必须像 reembed CLI 一样
    // 按游标翻完整页（SKIP 分页在收缩集合上会跳号，游标翻页是实现的正确用法）
    const collectAllTargets = async () => {
      const all: Awaited<ReturnType<typeof listNodeEmbeddingTargets>> = [];
      let cursor = "";
      for (let i = 0; i < 100; i++) {
        const page = await listNodeEmbeddingTargets(driver, cursor, 10);
        if (!page.length) break;
        all.push(...page);
        cursor = page[page.length - 1].id;
      }
      return all;
    };

    // 先有向量 → 清空后节点必须重新出现在待嵌入列表
    const vec = new Array(1024).fill(0).map((_, i) => (i % 10) / 10);
    await saveVector(driver, node.id, "reembed me", vec);
    expect((await collectAllTargets()).some(t => t.id === node.id)).toBe(false);

    const cleared = await clearAllEmbeddings(driver);
    expect(cleared.nodes).toBeGreaterThanOrEqual(1);

    const targets = await collectAllTargets();
    const target = targets.find(t => t.id === node.id);
    expect(target).toBeDefined();
    expect(target!.name).toBe("reembed-pipeline-skill"); // upsertNode 按规范化名入库

    // 游标分页：以该节点 id 为游标，它不再出现在下一页
    const next = await listNodeEmbeddingTargets(driver, node.id, 10);
    expect(next.some(t => t.id === node.id)).toBe(false);

    // 回填后再次从待嵌入列表消失（hash 一并恢复，syncEmbed 短路语义成立）
    const text = buildNodeEmbeddingText(target!);
    await saveVector(driver, node.id, text, vec);
    const hash = await getVectorHash(driver, node.id);
    expect(hash).toMatch(/^[a-f0-9]{32}$/);
    expect((await collectAllTargets()).some(t => t.id === node.id)).toBe(false);
  });

  it("重嵌入管线：社区向量清空/回填 + getVectorIndexDimensions", async () => {
    const session = getSession(driver);
    try {
      // 测试社区带 TEST_SID 以便 afterAll 清理扫到
      await session.run(`
        CREATE (c:Community {id: $id, summary: $summary, nodeCount: 1, sourceSessions: [$sid]})
      `, { id: `c-reembed-${TEST_SID}`, summary: "reembed community summary", sid: TEST_SID });

      const dimRes = await getVectorIndexDimensions(driver);
      expect(Object.keys(dimRes)).toContain("gm_node_embedding");
      expect(Object.keys(dimRes)).toContain("gm_community_embedding");
      // 两个索引要么都报维度，要么都不存在（initSchema 成对创建）
      if (dimRes.gm_node_embedding !== null && dimRes.gm_community_embedding !== null) {
        expect(dimRes.gm_node_embedding).toBe(dimRes.gm_community_embedding);
      }

      let targets = await listCommunityEmbeddingTargets(driver, "", 10);
      const target = targets.find(t => t.id === `c-reembed-${TEST_SID}`);
      expect(target).toBeDefined();
      expect(target!.summary).toBe("reembed community summary");

      const commVec = new Array(dimRes.gm_community_embedding ?? 1024).fill(0.5);
      await saveCommunityEmbedding(driver, target!.id, commVec);
      targets = await listCommunityEmbeddingTargets(driver, "", 10);
      expect(targets.some(t => t.id === `c-reembed-${TEST_SID}`)).toBe(false);

      await clearAllEmbeddings(driver);
      targets = await listCommunityEmbeddingTargets(driver, "", 10);
      expect(targets.some(t => t.id === `c-reembed-${TEST_SID}`)).toBe(true);
    } finally {
      await session.close();
    }
  });

  // ── 两阶段生命周期：遗忘曲线自动弃用 → 到期硬删（复活见 upsertNode/updateNode） ──
  // 隔离性注意：purge 与 applyDecay 用例作用于整个数据库（不限于 TEST_SID——
  // purge 的 MATCH 不带 sourceSessions 过滤，applyDecay 扫描全部 active 节点），
  // 依赖 AGENTS.md 约定「NEO4J_INTEGRATION=1 指向一次性 Neo4j」保证数据正确性。

  it("autoDeprecateNodes 批量标记 decay 弃用 + 切边 + 属性 + 前缀幂等", async () => {
    const { node: victim } = await upsertNode(driver, {
      type: "SKILL", name: "AutoDeprecate Target", description: "原描述", content: "content",
    }, TEST_SID);
    const { node: a } = await upsertNode(driver, {
      type: "TASK", name: "AutoDeprecate Neighbor A", description: "n", content: "n",
    }, TEST_SID);
    const { node: b } = await upsertNode(driver, {
      type: "SKILL", name: "AutoDeprecate Neighbor B", description: "n", content: "n",
    }, TEST_SID);
    await upsertEdge(driver, {
      fromId: a.id, toId: victim.id, type: "USED_SKILL",
      instruction: "uses", sessionId: TEST_SID,
    });
    await upsertEdge(driver, {
      fromId: victim.id, toId: b.id, type: "REQUIRES",
      instruction: "needs", sessionId: TEST_SID,
    });
    // 已带前缀的节点验证幂等（不双写）
    const { node: prefixed } = await upsertNode(driver, {
      type: "SKILL", name: "AutoDeprecate Prefixed", description: "[DEPRECATED] 已有前缀", content: "c",
    }, TEST_SID);

    const now = Date.now();
    expect(await autoDeprecateNodes(driver, [], now)).toBe(0);
    expect(await autoDeprecateNodes(driver, [victim.id, prefixed.id], now)).toBe(2);

    const v = await findById(driver, victim.id);
    expect(v!.status).toBe("deprecated");
    expect(v!.deprecatedBy).toBe("decay");
    expect(v!.deprecatedAt).toBe(now);
    expect(v!.description).toBe("[DEPRECATED] 原描述");
    expect(await edgesTo(driver, victim.id)).toHaveLength(0);
    expect(await edgesFrom(driver, victim.id)).toHaveLength(0);
    expect((await findById(driver, a.id))!.status).toBe("active");
    expect((await findById(driver, b.id))!.status).toBe("active");

    const p = await findById(driver, prefixed.id);
    expect(p!.deprecatedBy).toBe("decay");
    expect(p!.description).toBe("[DEPRECATED] 已有前缀");
  });

  it("autoDeprecateNodes 状态守卫：窗口内已被手动弃用的节点不被覆盖为 decay", async () => {
    const { node: manual } = await upsertNode(driver, {
      type: "SKILL", name: "AutoDeprecate Guard Manual", description: "手动弃用", content: "c",
    }, TEST_SID);
    const { node: active } = await upsertNode(driver, {
      type: "SKILL", name: "AutoDeprecate Guard Active", description: "仍活跃", content: "c",
    }, TEST_SID);

    // 模拟评分快照之后、批量写入之前落入窗口的手动弃用
    const manualAt = Date.now() - 1_000;
    await deprecateNodeAndDisconnectById(driver, manual.id, manualAt);

    const now = Date.now();
    // 只统计仍为 active 的节点：manual 已弃用不计入
    expect(await autoDeprecateNodes(driver, [manual.id, active.id], now)).toBe(1);

    const m = await findById(driver, manual.id);
    expect(m!.status).toBe("deprecated");
    expect(m!.deprecatedBy).toBe("manual");
    expect(m!.deprecatedAt).toBe(manualAt); // 溯源与 purge 时钟均不被 decay 覆盖

    const a = await findById(driver, active.id);
    expect(a!.status).toBe("deprecated");
    expect(a!.deprecatedBy).toBe("decay");
    expect(a!.deprecatedAt).toBe(now);
  });

  it("purgeDeprecatedNodes：过期 deprecated 硬删、未过期保留、active 不动、存量按 updatedAt 兜底", async () => {
    const { node: fresh } = await upsertNode(driver, {
      type: "SKILL", name: "Purge Fresh", description: "fresh", content: "c",
    }, TEST_SID);
    const { node: stale } = await upsertNode(driver, {
      type: "SKILL", name: "Purge Stale", description: "stale", content: "c",
    }, TEST_SID);
    const { node: legacy } = await upsertNode(driver, {
      type: "SKILL", name: "Purge Legacy", description: "legacy", content: "c",
    }, TEST_SID);
    const { node: keeper } = await upsertNode(driver, {
      type: "SKILL", name: "Purge Active Keeper", description: "active", content: "c",
    }, TEST_SID);

    const now = Date.now();
    const session = getSession(driver);
    try {
      // fresh：刚弃用（deprecatedAt = now），未到期
      await session.run(
        "MATCH (n {id: $id}) SET n.status='deprecated', n.deprecatedAt=$now, n.deprecatedBy='decay'",
        { id: fresh.id, now },
      );
      // stale：decay 弃用已超 60 天
      await session.run(
        "MATCH (n {id: $id}) SET n.status='deprecated', n.deprecatedAt=$old, n.deprecatedBy='decay'",
        { id: stale.id, old: now - 61 * 86_400_000 },
      );
      // legacy：无 deprecatedAt/deprecatedBy 的存量 deprecated —— 回退 updatedAt 基准，同样到期
      await session.run(
        "MATCH (n {id: $id}) SET n.status='deprecated', n.deprecatedAt=null, n.updatedAt=$old REMOVE n.deprecatedBy",
        { id: legacy.id, old: now - 61 * 86_400_000 },
      );
    } finally {
      await session.close();
    }

    // purgeAfterMs=0 显式关闭
    expect(await purgeDeprecatedNodes(driver, 0, now)).toBe(0);

    // 共享 DB 上可能存在其他遗留的过期 deprecated 节点，断言下界
    expect(await purgeDeprecatedNodes(driver, 60 * 86_400_000, now)).toBeGreaterThanOrEqual(2);
    expect(await findById(driver, stale.id)).toBeNull();
    expect(await findById(driver, legacy.id)).toBeNull();
    expect(await findById(driver, fresh.id)).not.toBeNull();
    expect((await findById(driver, keeper.id))!.status).toBe("active");
  });

  it("initSchema 存量迁移：为缺 deprecatedAt 的 deprecated 节点补写时钟（防 updatedAt 漂移无限续命）", async () => {
    const { node: legacy } = await upsertNode(driver, {
      type: "SKILL", name: "Backfill Legacy Deprecated", description: "存量弃用", content: "c",
    }, TEST_SID);
    const old = Date.now() - 90 * 86_400_000;
    const session = getSession(driver);
    try {
      // 模拟存量数据：deprecated 但无 deprecatedAt（按 manual 处理，不复活）
      await session.run(
        "MATCH (n {id: $id}) SET n.status='deprecated', n.updatedAt=$old REMOVE n.deprecatedAt, n.deprecatedBy",
        { id: legacy.id, old },
      );
    } finally {
      await session.close();
    }

    await initSchema(driver);
    expect((await findById(driver, legacy.id))!.deprecatedAt).toBe(old);

    // 补写后 manual 弃用节点被重新提取命中：upsertNode bump updatedAt（不复活），
    // 但 purge 时钟已钉死在 deprecatedAt，不再被推后（修复前：回退 updatedAt → 无限续命）
    const hit = await upsertNode(driver, {
      type: "SKILL", name: "Backfill Legacy Deprecated", description: "重新提取", content: "更长的内容触发更新路径",
    }, TEST_SID);
    expect(hit.isNew).toBe(false);
    expect(hit.node.status).toBe("deprecated");
    const refetched = await findById(driver, legacy.id);
    expect(refetched!.updatedAt!).toBeGreaterThan(old);
    expect(refetched!.deprecatedAt).toBe(old);

    // 幂等：重复 initSchema 不改写已存在的 deprecatedAt
    await initSchema(driver);
    expect((await findById(driver, legacy.id))!.deprecatedAt).toBe(old);
  });

  it("复活：decay 弃用节点被 upsertNode/updateNode 命中后回 active；manual 弃用不复活", async () => {
    // decay 弃用 → 重新提取 → 复活
    const { node: revivable } = await upsertNode(driver, {
      type: "SKILL", name: "Revive Target", description: "原描述", content: "c",
    }, TEST_SID);
    await autoDeprecateNodes(driver, [revivable.id], Date.now());
    expect((await findById(driver, revivable.id))!.status).toBe("deprecated");

    const revived = await upsertNode(driver, {
      type: "SKILL", name: "Revive Target", description: "再次提取的描述", content: "更长的内容触发更新路径",
    }, TEST_SID);
    expect(revived.isNew).toBe(false);
    expect(revived.node.status).toBe("active");
    expect(revived.node.description).toBe("原描述");
    expect(revived.node.deprecatedAt).toBeUndefined();
    expect(revived.node.deprecatedBy).toBeUndefined();

    const refetched = await findById(driver, revivable.id);
    expect(refetched!.status).toBe("active");
    expect(refetched!.description).toBe("原描述");
    expect(refetched!.deprecatedAt).toBeUndefined();

    // decay 弃用 → 手动编辑 → 复活（updateNode 路径）
    const { node: editable } = await upsertNode(driver, {
      type: "SKILL", name: "Revive Edit Target", description: "编辑前", content: "c",
    }, TEST_SID);
    await autoDeprecateNodes(driver, [editable.id], Date.now());
    const edited = await updateNode(driver, "Revive Edit Target", { content: "编辑后内容" });
    expect(edited!.status).toBe("active");
    expect(edited!.description).toBe("编辑前");

    // manual 弃用（deprecateNodeAndDisconnect）→ 重新提取不复活，前缀与弃用标记保留
    //（deprecatedAt/By 保留 = purge 时钟不被重新提取重置）
    await deprecateNodeAndDisconnect(driver, "Revive Target");
    const afterManual = await upsertNode(driver, {
      type: "SKILL", name: "Revive Target", description: "第三次提取", content: "更长的内容 2",
    }, TEST_SID);
    expect(afterManual.node.status).toBe("deprecated");
    expect(afterManual.node.description).toBe("[DEPRECATED] 原描述");
    expect(afterManual.node.deprecatedBy).toBe("manual");
    expect(afterManual.node.deprecatedAt).toBeGreaterThan(0);
  });

  it("applyDecay E2E：peripheral + 低分 + 超期未访问的节点被自动弃用", async () => {
    const { node: target } = await upsertNode(driver, {
      type: "SKILL", name: "Decay E2E Forgotten", description: "被遗忘的知识", content: "c",
    }, TEST_SID);
    // 构造遗忘终态：peripheral 层 + 400 天未访问 + 无 PageRank/访问加持
    const session = getSession(driver);
    try {
      await session.run(
        `MATCH (n {id: $id})
         SET n.tier='peripheral',
             n.createdAt=$old, n.updatedAt=$old, n.lastAccessedAt=$old,
             n.pagerank=0.0, n.validatedCount=1`,
        { id: target.id, old: Date.now() - 400 * 86_400_000 },
      );
    } finally {
      await session.close();
    }

    const result = await applyDecay(driver, { decay: { ...DEFAULT_CONFIG.decay!, autoDeprecate: true } });
    expect(result.enabled).toBe(true);
    expect(result.autoDeprecated).toBeGreaterThanOrEqual(1);

    const after = await findById(driver, target.id);
    expect(after!.status).toBe("deprecated");
    expect(after!.deprecatedBy).toBe("decay");
    expect(after!.description).toBe("[DEPRECATED] 被遗忘的知识");

    // 关闭开关后不再自动弃用（autoDeprecate=false 时 shouldAutoDeprecate 恒 false）
    const off = await applyDecay(driver, { decay: { ...DEFAULT_CONFIG.decay!, autoDeprecate: false } });
    expect(off.enabled).toBe(true);
    expect(off.autoDeprecated).toBe(0);
  });
});
