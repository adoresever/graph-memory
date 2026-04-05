/**
 * graph-memory — 图算法测试
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 *
 * 测试个性化 PageRank、全局 PageRank、社区检测、向量去重
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import { createTestDb, insertNode, insertEdge } from "./helpers.ts";
import { personalizedPageRank, computeGlobalPageRank, invalidateGraphCache } from "../src/graph/pagerank.ts";
import { detectCommunities, getCommunityPeers } from "../src/graph/community.ts";
import { detectDuplicates, dedup } from "../src/graph/dedup.ts";
import { runMaintenance } from "../src/graph/maintenance.ts";
import { saveVector } from "../src/store/store.ts";
import { DEFAULT_CONFIG, type GmConfig } from "../src/types.ts";

let db: DatabaseSyncInstance;
const cfg: GmConfig = { ...DEFAULT_CONFIG };

beforeEach(() => {
  db = createTestDb();
  invalidateGraphCache(db);
});

// ═══════════════════════════════════════════════════════════════
// 个性化 PageRank
// ═══════════════════════════════════════════════════════════════

describe("Personalized PageRank", () => {
  /**
   * 构建测试图：
   *
   *   [docker-deploy] → [docker-compose-up] → [docker-port-expose]
   *                                          ↓
   *                                    [nginx-config]
   *
   *   [conda-env-create] → [pip-install]
   *
   * 从 docker-deploy 出发，docker 相关节点应该分数远高于 conda 相关
   */
  it("从种子出发的节点分数高于远端节点", () => {
    const dockerDeploy = insertNode(db, { name: "docker-deploy", type: "TASK" });
    const composeUp = insertNode(db, { name: "docker-compose-up", type: "SKILL" });
    const portExpose = insertNode(db, { name: "docker-port-expose", type: "SKILL" });
    const nginx = insertNode(db, { name: "nginx-config", type: "SKILL" });
    const condaCreate = insertNode(db, { name: "conda-env-create", type: "SKILL" });
    const pipInstall = insertNode(db, { name: "pip-install", type: "SKILL" });

    insertEdge(db, { fromId: dockerDeploy, toId: composeUp, type: "USED_SKILL" });
    insertEdge(db, { fromId: composeUp, toId: portExpose, type: "REQUIRES" });
    insertEdge(db, { fromId: composeUp, toId: nginx, type: "USED_SKILL" });
    insertEdge(db, { fromId: condaCreate, toId: pipInstall, type: "REQUIRES" });

    const all = [dockerDeploy, composeUp, portExpose, nginx, condaCreate, pipInstall];

    // 从 docker-deploy 出发
    const { scores } = personalizedPageRank(db, [dockerDeploy], all, cfg);

    const dockerScore = scores.get(composeUp) || 0;
    const condaScore = scores.get(condaCreate) || 0;

    // docker 相关节点应该分数远高于 conda（没有路径连接）
    expect(dockerScore).toBeGreaterThan(condaScore);
    expect(dockerScore).toBeGreaterThan(0);
  });

  it("不同种子产生不同排序", () => {
    const a = insertNode(db, { name: "node-a" });
    const b = insertNode(db, { name: "node-b" });
    const c = insertNode(db, { name: "shared-node" });

    insertEdge(db, { fromId: a, toId: c });
    insertEdge(db, { fromId: b, toId: c });

    const all = [a, b, c];

    const fromA = personalizedPageRank(db, [a], all, cfg);
    const fromB = personalizedPageRank(db, [b], all, cfg);

    // 从 a 出发：a 的分数最高
    expect((fromA.scores.get(a) || 0)).toBeGreaterThan((fromA.scores.get(b) || 0));
    // 从 b 出发：b 的分数最高
    expect((fromB.scores.get(b) || 0)).toBeGreaterThan((fromB.scores.get(a) || 0));
  });

  it("空种子返回空 scores", () => {
    insertNode(db, { name: "some-node" });
    const { scores } = personalizedPageRank(db, [], ["some-node"], cfg);
    expect(scores.size).toBe(0);
  });

  it("空图不报错", () => {
    const { scores } = personalizedPageRank(db, ["fake-id"], ["fake-id"], cfg);
    expect(scores.size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 全局 PageRank
// ═══════════════════════════════════════════════════════════════

describe("Global PageRank", () => {
  it("hub 节点分数最高", () => {
    // hub 被多个节点连接
    const hub = insertNode(db, { name: "hub-skill" });
    const a = insertNode(db, { name: "task-a", type: "TASK" });
    const b = insertNode(db, { name: "task-b", type: "TASK" });
    const c = insertNode(db, { name: "task-c", type: "TASK" });
    const leaf = insertNode(db, { name: "leaf-node" });

    insertEdge(db, { fromId: a, toId: hub });
    insertEdge(db, { fromId: b, toId: hub });
    insertEdge(db, { fromId: c, toId: hub });
    insertEdge(db, { fromId: hub, toId: leaf });

    const { scores, topK } = computeGlobalPageRank(db, cfg);

    expect(topK[0].name).toBe("hub-skill");
    expect((scores.get(hub) || 0)).toBeGreaterThan((scores.get(leaf) || 0));
  });

  it("写入 gm_nodes.pagerank 列", () => {
    const a = insertNode(db, { name: "node-a" });
    const b = insertNode(db, { name: "node-b" });
    insertEdge(db, { fromId: a, toId: b });

    computeGlobalPageRank(db, cfg);

    const row = db.prepare("SELECT pagerank FROM gm_nodes WHERE id=?").get(a) as any;
    expect(row.pagerank).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 社区检测
// ═══════════════════════════════════════════════════════════════

describe("Community Detection", () => {
  it("连通的节点归入同一社区", () => {
    // 社区 1：Docker 相关
    const d1 = insertNode(db, { name: "docker-build" });
    const d2 = insertNode(db, { name: "docker-push" });
    const d3 = insertNode(db, { name: "dockerfile-write" });
    insertEdge(db, { fromId: d1, toId: d2 });
    insertEdge(db, { fromId: d1, toId: d3 });

    // 社区 2：Python 相关（和 Docker 不连通）
    const p1 = insertNode(db, { name: "pip-install" });
    const p2 = insertNode(db, { name: "venv-create" });
    insertEdge(db, { fromId: p1, toId: p2 });

    const { labels, count } = detectCommunities(db);

    // 至少 2 个社区
    expect(count).toBeGreaterThanOrEqual(2);

    // Docker 三个节点应该在同一社区
    const dockerCommunity = labels.get(d1);
    expect(labels.get(d2)).toBe(dockerCommunity);
    expect(labels.get(d3)).toBe(dockerCommunity);

    // Python 两个节点在另一个社区
    const pythonCommunity = labels.get(p1);
    expect(labels.get(p2)).toBe(pythonCommunity);
    expect(pythonCommunity).not.toBe(dockerCommunity);
  });

  it("孤立节点各自一个社区", () => {
    insertNode(db, { name: "isolated-a" });
    insertNode(db, { name: "isolated-b" });

    const { count } = detectCommunities(db);
    expect(count).toBe(2);
  });

  it("getCommunityPeers 返回同社区节点", () => {
    const a = insertNode(db, { name: "a" });
    const b = insertNode(db, { name: "b" });
    const c = insertNode(db, { name: "c" });
    insertEdge(db, { fromId: a, toId: b });
    insertEdge(db, { fromId: b, toId: c });

    detectCommunities(db);

    const peers = getCommunityPeers(db, a, 5);
    // b 和 c 应该是 a 的社区成员
    expect(peers.length).toBeGreaterThan(0);
  });

  it("空图不报错", () => {
    const { count } = detectCommunities(db);
    expect(count).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 向量去重
// ═══════════════════════════════════════════════════════════════

describe("Vector Dedup", () => {
  it("相似向量被检测为重复", () => {
    const a = insertNode(db, { name: "conda-env-create", type: "SKILL" });
    const b = insertNode(db, { name: "conda-create-environment", type: "SKILL" });

    // 构造两个非常相似的向量
    const vecA = Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.1));
    const vecB = Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.1) + 0.01); // 微小差异

    saveVector(db, a, "content a", vecA);
    saveVector(db, b, "content b", vecB);

    const pairs = detectDuplicates(db, { ...cfg, dedupThreshold: 0.9 });
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    expect(pairs[0].similarity).toBeGreaterThan(0.9);
  });

  it("不同向量不被当作重复", () => {
    const a = insertNode(db, { name: "docker-build", type: "SKILL" });
    const b = insertNode(db, { name: "conda-create", type: "SKILL" });

    // 构造正交向量：前半 vs 后半，余弦相似度 ≈ 0
    const vecA = Array.from({ length: 64 }, (_, i) => i < 32 ? 1 : 0);
    const vecB = Array.from({ length: 64 }, (_, i) => i >= 32 ? 1 : 0);

    saveVector(db, a, "content a", vecA);
    saveVector(db, b, "content b", vecB);

    const pairs = detectDuplicates(db, { ...cfg, dedupThreshold: 0.9 });
    expect(pairs).toHaveLength(0);
  });

  it("dedup 自动合并同类型重复节点", () => {
    const a = insertNode(db, { name: "skill-v1", type: "SKILL", validatedCount: 5 });
    const b = insertNode(db, { name: "skill-v1-dup", type: "SKILL", validatedCount: 2 });

    const vec = Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.1));
    saveVector(db, a, "content", vec);
    saveVector(db, b, "content", vec); // 完全相同的向量

    const { merged } = dedup(db, { ...cfg, dedupThreshold: 0.9 });
    expect(merged).toBe(1);

    // a 应该还是 active（validatedCount 更高）
    const aAfter = db.prepare("SELECT status, validated_count FROM gm_nodes WHERE id=?").get(a) as any;
    expect(aAfter.status).toBe("active");
    expect(aAfter.validated_count).toBe(7); // 5 + 2

    // b 应该 deprecated
    const bAfter = db.prepare("SELECT status FROM gm_nodes WHERE id=?").get(b) as any;
    expect(bAfter.status).toBe("deprecated");
  });

  it("不同类型不合并", () => {
    const a = insertNode(db, { name: "skill-x", type: "SKILL" });
    const b = insertNode(db, { name: "event-x", type: "EVENT" });

    const vec = Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.1));
    saveVector(db, a, "content", vec);
    saveVector(db, b, "content", vec);

    const { merged } = dedup(db, { ...cfg, dedupThreshold: 0.9 });
    expect(merged).toBe(0);
  });

  it("没有向量时安全跳过", () => {
    insertNode(db, { name: "no-vec" });
    const { pairs, merged } = dedup(db, cfg);
    expect(pairs).toHaveLength(0);
    expect(merged).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 全套 maintenance
// ═══════════════════════════════════════════════════════════════

describe("runMaintenance", () => {
  it("全套运行不报错", async () => {
    const a = insertNode(db, { name: "skill-a" });
    const b = insertNode(db, { name: "skill-b" });
    const c = insertNode(db, { name: "task-c", type: "TASK" });
    insertEdge(db, { fromId: c, toId: a, type: "USED_SKILL" });
    insertEdge(db, { fromId: c, toId: b, type: "USED_SKILL" });

    const result = await runMaintenance(db, cfg);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.pagerank.topK.length).toBeGreaterThan(0);
    expect(result.community.count).toBeGreaterThan(0);
  });

  it("空图不报错", async () => {
    const result = await runMaintenance(db, cfg);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.pagerank.topK).toHaveLength(0);
    expect(result.community.count).toBe(0);
  });
});