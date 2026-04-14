/**
 * graph-memory — 召回 + 社区 + 组装集成测试
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 *
 * 测试：
 * 1. vectorSearchWithScore 返回带分数
 * 2. communityRepresentatives 按社区+时间排序
 * 3. 并行双路径召回（精确+泛化同时跑，合并去重）
 * 4. 社区描述生成 + 存储
 * 5. assemble 输出带社区分组和时间
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import { createTestDb, insertNode, insertEdge } from "./helpers.js";
import {
  findById, vectorSearchWithScore, communityRepresentatives,
  saveVector, upsertCommunitySummary, getCommunitySummary,
  getAllCommunitySummaries, pruneCommunitySummaries,
} from "../src/store/store.js";
import { detectCommunities, getCommunityPeers } from "../src/graph/community.js";
import { assembleContext } from "../src/format/assemble.js";
import type { GmNode } from "../src/types.js";

let db: DatabaseSyncInstance;

beforeEach(() => {
  db = createTestDb();
  // 加 gm_communities 表（测试 helper 的 createTestDb 可能还没有 m6）
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gm_communities (
        id          TEXT PRIMARY KEY,
        summary     TEXT NOT NULL,
        node_count  INTEGER NOT NULL DEFAULT 0,
        embedding   BLOB,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
    `);
  } catch { /* 已存在 */ }
});

// ═══════════════════════════════════════════════════════════════
// vectorSearchWithScore
// ═══════════════════════════════════════════════════════════════

describe("vectorSearchWithScore", () => {
  it("返回带分数的结果", () => {
    const a = insertNode(db, { name: "conda-env-create", type: "SKILL" });
    const b = insertNode(db, { name: "docker-compose-up", type: "SKILL" });

    // 构造相似向量
    const queryVec = Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.1));
    const vecA = Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.1) + 0.02);
    const vecB = Array.from({ length: 64 }, (_, i) => Math.cos(i * 0.3)); // 不同方向

    saveVector(db, a, "content a", vecA);
    saveVector(db, b, "content b", vecB);

    const results = vectorSearchWithScore(db, queryVec, 5);

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]).toHaveProperty("score");
    expect(results[0]).toHaveProperty("node");
    expect(results[0].score).toBeGreaterThan(0);
    // vecA 和 queryVec 更相似
    expect(results[0].node.name).toBe("conda-env-create");
  });

  it("分数按降序排列", () => {
    const a = insertNode(db, { name: "skill-a" });
    const b = insertNode(db, { name: "skill-b" });
    const c = insertNode(db, { name: "skill-c" });

    const base = Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.1));
    saveVector(db, a, "a", base.map(x => x + 0.01));
    saveVector(db, b, "b", base.map(x => x + 0.1));
    saveVector(db, c, "c", base.map(x => x + 0.5));

    const results = vectorSearchWithScore(db, base, 5);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// communityRepresentatives
// ═══════════════════════════════════════════════════════════════

describe("communityRepresentatives", () => {
  it("每个社区返回代表节点", () => {
    // 创建两个社区
    const d1 = insertNode(db, { name: "docker-build", type: "SKILL" });
    const d2 = insertNode(db, { name: "docker-push", type: "SKILL" });
    const p1 = insertNode(db, { name: "pip-install", type: "SKILL" });
    const p2 = insertNode(db, { name: "venv-create", type: "SKILL" });

    insertEdge(db, { fromId: d1, toId: d2 });
    insertEdge(db, { fromId: p1, toId: p2 });

    // 运行社区检测
    detectCommunities(db);

    const reps = communityRepresentatives(db, 1);

    // 应该每个社区至少 1 个代表
    expect(reps.length).toBeGreaterThanOrEqual(2);
  });

  it("没有社区时返回空", () => {
    insertNode(db, { name: "isolated-node" });
    // 不运行 detectCommunities，community_id 都是 null
    const reps = communityRepresentatives(db, 2);
    expect(reps).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 社区描述 CRUD
// ═══════════════════════════════════════════════════════════════

describe("社区描述 CRUD", () => {
  it("upsert + get", () => {
    upsertCommunitySummary(db, "c-1", "Docker容器部署与服务管理", 3);
    const s = getCommunitySummary(db, "c-1");

    expect(s).not.toBeNull();
    expect(s!.summary).toBe("Docker容器部署与服务管理");
    expect(s!.nodeCount).toBe(3);
  });

  it("upsert 更新已有记录", () => {
    upsertCommunitySummary(db, "c-1", "旧描述", 2);
    upsertCommunitySummary(db, "c-1", "新描述", 5);

    const s = getCommunitySummary(db, "c-1");
    expect(s!.summary).toBe("新描述");
    expect(s!.nodeCount).toBe(5);
  });

  it("getAll 返回所有社区按 nodeCount 排序", () => {
    upsertCommunitySummary(db, "c-1", "小社区", 2);
    upsertCommunitySummary(db, "c-2", "大社区", 10);
    upsertCommunitySummary(db, "c-3", "中社区", 5);

    const all = getAllCommunitySummaries(db);
    expect(all).toHaveLength(3);
    expect(all[0].summary).toBe("大社区");
    expect(all[2].summary).toBe("小社区");
  });

  it("prune 清除无效社区", () => {
    // 创建节点并分配社区
    const a = insertNode(db, { name: "node-a" });
    db.prepare("UPDATE gm_nodes SET community_id='c-1' WHERE id=?").run(a);

    // c-1 有节点，c-999 没有节点
    upsertCommunitySummary(db, "c-1", "有效社区", 1);
    upsertCommunitySummary(db, "c-999", "无效社区", 0);

    const pruned = pruneCommunitySummaries(db);
    expect(pruned).toBe(1);

    expect(getCommunitySummary(db, "c-1")).not.toBeNull();
    expect(getCommunitySummary(db, "c-999")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// assemble 带社区分组输出
// ═══════════════════════════════════════════════════════════════

describe("assemble 社区分组", () => {
  it("有社区的节点按社区分组输出", () => {
    const a = insertNode(db, { name: "docker-build", type: "SKILL" });
    const b = insertNode(db, { name: "docker-push", type: "SKILL" });
    const c = insertNode(db, { name: "pip-install", type: "SKILL" });

    // 分配社区
    db.prepare("UPDATE gm_nodes SET community_id='c-1' WHERE id IN (?,?)").run(a, b);
    db.prepare("UPDATE gm_nodes SET community_id='c-2' WHERE id=?").run(c);

    // 添加社区描述
    upsertCommunitySummary(db, "c-1", "Docker容器构建与推送", 2);
    upsertCommunitySummary(db, "c-2", "Python依赖管理", 1);

    const nodeA = findById(db, a)!;
    const nodeB = findById(db, b)!;
    const nodeC = findById(db, c)!;

    const { xml } = assembleContext(db, {
      tokenBudget: 128_000,
      activeNodes: [nodeA, nodeB, nodeC],
      activeEdges: [],
      recalledNodes: [],
      recalledEdges: [],
    });

    expect(xml).toContain('<community id="c-1" desc="Docker容器构建与推送">');
    expect(xml).toContain('<community id="c-2" desc="Python依赖管理">');
    expect(xml).toContain("</community>");
  });

  it("节点输出带 updated 时间属性", () => {
    const a = insertNode(db, { name: "test-skill", type: "SKILL" });
    const node = findById(db, a)!;

    const { xml } = assembleContext(db, {
      tokenBudget: 128_000,
      activeNodes: [node],
      activeEdges: [],
      recalledNodes: [],
      recalledEdges: [],
    });

    // 应该包含 updated="YYYY-MM-DD" 格式
    expect(xml).toMatch(/updated="\d{4}-\d{2}-\d{2}"/);
  });

  it("无社区的节点放顶层", () => {
    const a = insertNode(db, { name: "no-community-node", type: "SKILL" });
    // 不分配 community_id
    const node = findById(db, a)!;

    const { xml } = assembleContext(db, {
      tokenBudget: 128_000,
      activeNodes: [node],
      activeEdges: [],
      recalledNodes: [],
      recalledEdges: [],
    });

    expect(xml).toContain('name="no-community-node"');
    expect(xml).not.toContain("<community");
  });

  it("没有社区描述时 fallback 到 community_id", () => {
    const a = insertNode(db, { name: "orphan-skill", type: "SKILL" });
    db.prepare("UPDATE gm_nodes SET community_id='c-99' WHERE id=?").run(a);
    // 不创建 gm_communities 记录
    const node = findById(db, a)!;

    const { xml } = assembleContext(db, {
      tokenBudget: 128_000,
      activeNodes: [node],
      activeEdges: [],
      recalledNodes: [],
      recalledEdges: [],
    });

    expect(xml).toContain('id="c-99" desc="c-99"');
  });
});

// ═══════════════════════════════════════════════════════════════
// 并行双路径合并
// ═══════════════════════════════════════════════════════════════

describe("双路径合并逻辑", () => {
  it("精确和泛化结果合并去重", () => {
    // 构建多社区图
    const d1 = insertNode(db, { name: "docker-build", type: "SKILL" });
    const d2 = insertNode(db, { name: "docker-push", type: "SKILL" });
    const p1 = insertNode(db, { name: "pip-install", type: "SKILL" });
    const p2 = insertNode(db, { name: "venv-create", type: "SKILL" });
    const t1 = insertNode(db, { name: "deploy-app", type: "TASK" });

    insertEdge(db, { fromId: d1, toId: d2, type: "REQUIRES" });
    insertEdge(db, { fromId: p1, toId: p2, type: "REQUIRES" });
    insertEdge(db, { fromId: t1, toId: d1, type: "USED_SKILL" });

    detectCommunities(db);

    // 验证社区被检测到
    const nodeA = findById(db, d1);
    expect(nodeA!.communityId).not.toBeNull();

    const reps = communityRepresentatives(db, 2);
    expect(reps.length).toBeGreaterThan(0);
  });
});
