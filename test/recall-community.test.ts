/**
 * graph-memory — 召回 + 社区 + 组装集成测试
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 *
 * 测试：
 * 1. vectorSearchWithScore 返回带分数
 * 2. communityRepresentatives 按社区+时间排序
 * 3. 社区维护数据与查询召回相互独立
 * 4. 社区描述生成 + 存储
 * 5. assemble 输出带社区分组和时间
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync, type DatabaseSyncInstance } from "../src/store/sqlite.ts";
import { createTestDb, insertNode, insertEdge } from "./helpers.ts";
import {
  findById, vectorSearchWithScore, communityRepresentatives,
  saveVector,
} from "../src/store/store.ts";
import { detectCommunities, getCommunityPeers } from "../src/graph/community.ts";
import { assembleContext } from "../src/format/assemble.ts";
import type { GmNode } from "../src/types.ts";

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

    const nodeA = findById(db, a)!;
    const nodeB = findById(db, b)!;
    const nodeC = findById(db, c)!;

    const { xml } = assembleContext(db, {
      recalledNodes: [nodeA, nodeB, nodeC],
      recalledEdges: [],
    });

    expect(xml).toContain('<community id="c-1">');
    expect(xml).toContain('<community id="c-2">');
    expect(xml).toContain("</community>");
  });

  it("节点输出带 updated 时间属性", () => {
    const a = insertNode(db, { name: "test-skill", type: "SKILL" });
    const node = findById(db, a)!;

    const { xml } = assembleContext(db, {
      recalledNodes: [node],
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
      recalledNodes: [node],
      recalledEdges: [],
    });

    expect(xml).toContain('name="no-community-node"');
    expect(xml).not.toContain("<community");
  });

  it("社区分组不依赖二次 LLM 摘要", () => {
    const a = insertNode(db, { name: "orphan-skill", type: "SKILL" });
    db.prepare("UPDATE gm_nodes SET community_id='c-99' WHERE id=?").run(a);
    const node = findById(db, a)!;

    const { xml } = assembleContext(db, {
      recalledNodes: [node],
      recalledEdges: [],
    });

    expect(xml).toContain('id="c-99"');
  });
});

// ═══════════════════════════════════════════════════════════════
// 社区维护不改写查询排序
// ═══════════════════════════════════════════════════════════════

describe("社区维护数据", () => {
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
