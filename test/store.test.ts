/**
 * graph-memory — store 层测试
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync, type DatabaseSyncInstance } from "../src/store/sqlite.ts";
import { createTestDb, insertNode, insertEdge } from "./helpers.ts";
import {
  findByName, findById, upsertNode, upsertEdge, updateNode, deprecate,
  mergeNodes, edgesFrom, edgesTo, allActiveNodes, allEdges,
  searchNodes, topNodes, graphWalk, getBySession,
  saveMessage, saveMessageOnce, getMessages, getUnextracted, markExtracted, getEpisodicMessages,
  getNodeSourceMessages,
  saveSignal, pendingSignals, markSignalsDone,
  getStats, saveVector, vectorSearch, getAllVectors, upsertCommunitySummary,
  vectorSearchWithScore,
} from "../src/store/store.ts";

let db: DatabaseSyncInstance;

beforeEach(() => {
  db = createTestDb();
});

describe("vector dimensions", () => {
  it("never compares vectors with different dimensions", () => {
    const { node } = upsertNode(db, {
      type: "SKILL", name: "mixed-dimension", description: "", content: "test",
    }, "s1");
    saveVector(db, node.id, "test", [1, 0, 0]);
    expect(vectorSearchWithScore(db, [1, 0], 5, -1)).toEqual([]);
  });
});

describe("host event messages", () => {
  it("stores one DSH event idempotently and renders nested content blocks", () => {
    const payload = {
      role: "assistant",
      content: [
        { type: "reasoning", text: "internal analysis" },
        { type: "text", text: "Graph Memory is active" },
      ],
    };

    expect(saveMessageOnce(db, "dsh:s1:7", "dsh:s1", 7, "assistant", payload)).toBe(true);
    expect(saveMessageOnce(db, "dsh:s1:7", "dsh:s1", 7, "assistant", payload)).toBe(false);
    expect(getMessages(db, "dsh:s1")).toHaveLength(1);

    const episodic = getEpisodicMessages(db, ["dsh:s1"], Date.now());
    expect(episodic).toHaveLength(1);
    expect(episodic[0].text).toContain("internal analysis");
    expect(episodic[0].text).toContain("Graph Memory is active");
    expect(episodic[0].text).not.toContain("[object Object]");
  });

  it("reads exact node evidence instead of guessing by session time", () => {
    saveMessageOnce(db, "dsh:s1:7", "dsh:s1", 7, "user", {
      role: "user", content: [{ type: "text", text: "unrelated earlier text" }],
    });
    saveMessageOnce(db, "dsh:s1:19", "dsh:s1", 19, "assistant", {
      role: "assistant", content: [{ type: "text", text: "the exact retained evidence" }],
    });
    const { node } = upsertNode(db, {
      type: "EVENT", name: "exact-source", description: "", content: "summary",
    }, "dsh:s1", [{ messageId: "dsh:s1:19", turnIndex: 19 }]);

    expect(getNodeSourceMessages(db, node.id, 1000).map(message => message.text)).toEqual([
      "the exact retained evidence",
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════
// 节点 CRUD
// ═══════════════════════════════════════════════════════════════

describe("node CRUD", () => {
  it("upsertNode 创建新节点", () => {
    const { node, isNew } = upsertNode(db, {
      type: "SKILL", name: "conda-env-create",
      description: "创建 conda 环境", content: "## conda-env-create\n### 步骤\n1. conda create -n xxx",
    }, "s1");

    expect(isNew).toBe(true);
    expect(node.name).toBe("conda-env-create");
    expect(node.type).toBe("SKILL");
    expect(node.validatedCount).toBe(1);
  });

  it("upsertNode 同名节点 merge 而非重复创建", () => {
    upsertNode(db, {
      type: "SKILL", name: "conda-env-create",
      description: "短描述", content: "短内容",
    }, "s1");

    const { node, isNew } = upsertNode(db, {
      type: "SKILL", name: "conda-env-create",
      description: "更长的描述说明", content: "更长更完整的内容说明文档",
    }, "s2");

    expect(isNew).toBe(false);
    expect(node.validatedCount).toBe(2);
    // 保留更长的
    expect(node.description).toBe("更长的描述说明");
    expect(node.content).toBe("更长更完整的内容说明文档");
  });

  it("name 自动标准化：大写→小写，空格→连字符", () => {
    upsertNode(db, {
      type: "SKILL", name: "Docker Port Expose",
      description: "test", content: "test",
    }, "s1");

    const found = findByName(db, "docker-port-expose");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("docker-port-expose");
  });

  it("deprecate 标记节点失效", () => {
    const { node } = upsertNode(db, {
      type: "EVENT", name: "old-error",
      description: "旧错误", content: "已过时",
    }, "s1");

    deprecate(db, node.id);
    const after = findById(db, node.id);
    expect(after!.status).toBe("deprecated");
  });

  it("findByName 找不到返回 null", () => {
    expect(findByName(db, "not-exist")).toBeNull();
  });

  it("updateNode 找不到节点返回 null", () => {
    expect(updateNode(db, "ghost", { description: "x" })).toBeNull();
    expect(updateNode(db, "ghost", { content: "y" })).toBeNull();
  });

  it("updateNode 只更新 description，保留 content", () => {
    const { node } = upsertNode(db, {
      type: "SKILL", name: "docker-build",
      description: "旧描述", content: "原内容保持不变",
    }, "s1");

    const updated = updateNode(db, "docker-build", { description: "新描述" });
    expect(updated).not.toBeNull();
    expect(updated!.description).toBe("新描述");
    expect(updated!.content).toBe("原内容保持不变");
  });

  it("updateNode 只更新 content，保留 description", () => {
    upsertNode(db, {
      type: "SKILL", name: "docker-run",
      description: "描述不动", content: "旧内容",
    }, "s1");

    const updated = updateNode(db, "docker-run", { content: "全新内容" });
    expect(updated).not.toBeNull();
    expect(updated!.description).toBe("描述不动");
    expect(updated!.content).toBe("全新内容");
  });

  it("updateNode 同时更新 description 和 content", () => {
    upsertNode(db, {
      type: "EVENT", name: "oom-crash",
      description: "旧", content: "旧内容",
    }, "s1");

    const updated = updateNode(db, "oom-crash", {
      description: "新描述", content: "新内容",
    });
    expect(updated!.description).toBe("新描述");
    expect(updated!.content).toBe("新内容");
  });

  it("updateNode 保留 type/name/status/validatedCount，刷新 updated_at", () => {
    const { node } = upsertNode(db, {
      type: "SKILL", name: "preserve-me",
      description: "d1", content: "c1",
    }, "s1");
    // 第二次 upsert 把 validated_count 提到 2
    upsertNode(db, {
      type: "SKILL", name: "preserve-me",
      description: "d1", content: "c1",
    }, "s2");
    const before = findByName(db, "preserve-me")!;
    expect(before.validatedCount).toBe(2);

    const updated = updateNode(db, "preserve-me", { content: "refined" });
    expect(updated!.type).toBe("SKILL");
    expect(updated!.name).toBe("preserve-me");
    expect(updated!.status).toBe("active");
    expect(updated!.validatedCount).toBe(2);
    expect(updated!.sourceSessions).toEqual(["s1", "s2"]);
    expect(updated!.content).toBe("refined");
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  });
});

describe("community summary CRUD", () => {
  it("clears a stale embedding when a changed summary cannot be re-embedded", () => {
    upsertCommunitySummary(db, "c1", "old summary", 2, [1, 0], "old-signature");
    upsertCommunitySummary(db, "c1", "new summary", 3, undefined, "new-signature");

    const row = db.prepare(
      "SELECT summary, node_count, embedding, member_signature FROM gm_communities WHERE id=?",
    ).get("c1") as any;
    expect(row.summary).toBe("new summary");
    expect(row.node_count).toBe(3);
    expect(row.embedding).toBeNull();
    expect(row.member_signature).toBe("new-signature");
  });
});

// ═══════════════════════════════════════════════════════════════
// 边 CRUD
// ═══════════════════════════════════════════════════════════════

describe("edge CRUD", () => {
  it("upsertEdge 创建边", () => {
    const a = insertNode(db, { name: "task-a", type: "TASK" });
    const b = insertNode(db, { name: "skill-b", type: "SKILL" });

    upsertEdge(db, {
      fromId: a, toId: b, type: "USED_SKILL",
      instruction: "第 1 步使用", sessionId: "s1",
    });

    const from = edgesFrom(db, a);
    const to = edgesTo(db, b);
    expect(from).toHaveLength(1);
    expect(to).toHaveLength(1);
    expect(from[0].type).toBe("USED_SKILL");
  });

  it("upsertEdge 同 from+to+type 更新 instruction 而非重复", () => {
    const a = insertNode(db, { name: "task-a", type: "TASK" });
    const b = insertNode(db, { name: "skill-b", type: "SKILL" });

    upsertEdge(db, { fromId: a, toId: b, type: "USED_SKILL", instruction: "v1", sessionId: "s1" });
    upsertEdge(db, { fromId: a, toId: b, type: "USED_SKILL", instruction: "v2", sessionId: "s2" });

    const edges = edgesFrom(db, a);
    expect(edges).toHaveLength(1);
    expect(edges[0].instruction).toBe("v2");
  });
});

// ═══════════════════════════════════════════════════════════════
// 节点合并
// ═══════════════════════════════════════════════════════════════

describe("mergeNodes", () => {
  it("合并后边迁移、被合并节点 deprecated", () => {
    const a = insertNode(db, { name: "keep-node", validatedCount: 5 });
    const b = insertNode(db, { name: "merge-node", validatedCount: 3 });
    const c = insertNode(db, { name: "other-node" });

    insertEdge(db, { fromId: b, toId: c, type: "SOLVED_BY" });

    mergeNodes(db, a, b);

    // b 应该 deprecated
    const bAfter = findById(db, b);
    expect(bAfter!.status).toBe("deprecated");

    // a 的 validatedCount = 5 + 3 = 8
    const aAfter = findById(db, a);
    expect(aAfter!.validatedCount).toBe(8);

    // 边应该迁移到 a
    const edges = edgesFrom(db, a);
    expect(edges.some(e => e.toId === c)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// FTS5 搜索
// ═══════════════════════════════════════════════════════════════

describe("FTS5 search", () => {
  it("按关键词搜索节点", () => {
    upsertNode(db, {
      type: "SKILL", name: "docker-compose-up",
      description: "启动 Docker Compose 服务",
      content: "docker compose up -d",
    }, "s1");

    upsertNode(db, {
      type: "SKILL", name: "conda-env-create",
      description: "创建 conda 环境",
      content: "conda create -n myenv python=3.10",
    }, "s1");

    const results = searchNodes(db, "docker", 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toBe("docker-compose-up");
  });

  it("搜索空字符串返回 topNodes", () => {
    insertNode(db, { name: "node-a", validatedCount: 10 });
    insertNode(db, { name: "node-b", validatedCount: 1 });

    const results = searchNodes(db, "", 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// 图遍历
// ═══════════════════════════════════════════════════════════════

describe("graphWalk", () => {
  it("从种子节点遍历 1 跳", () => {
    const a = insertNode(db, { name: "seed" });
    const b = insertNode(db, { name: "neighbor-1" });
    const c = insertNode(db, { name: "neighbor-2" });
    const d = insertNode(db, { name: "far-away" });

    insertEdge(db, { fromId: a, toId: b });
    insertEdge(db, { fromId: a, toId: c });
    insertEdge(db, { fromId: c, toId: d });

    const { nodes, edges } = graphWalk(db, [a], 1);

    // 1 跳应该找到 a, b, c（不包括 d）
    const names = nodes.map(n => n.name).sort();
    expect(names).toContain("seed");
    expect(names).toContain("neighbor-1");
    expect(names).toContain("neighbor-2");
    expect(names).not.toContain("far-away");
  });

  it("2 跳能到达更远的节点", () => {
    const a = insertNode(db, { name: "seed" });
    const b = insertNode(db, { name: "hop-1" });
    const c = insertNode(db, { name: "hop-2" });

    insertEdge(db, { fromId: a, toId: b });
    insertEdge(db, { fromId: b, toId: c });

    const { nodes } = graphWalk(db, [a], 2);
    expect(nodes.map(n => n.name)).toContain("hop-2");
  });

  it("空种子返回空", () => {
    const { nodes, edges } = graphWalk(db, [], 2);
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 消息 + 信号
// ═══════════════════════════════════════════════════════════════

describe("messages & signals", () => {
  it("saveMessage + getUnextracted + markExtracted", () => {
    saveMessage(db, "s1", 1, "user", "hello");
    saveMessage(db, "s1", 2, "assistant", "hi");
    saveMessage(db, "s1", 3, "user", "help me");

    let unext = getUnextracted(db, "s1", 10);
    expect(unext).toHaveLength(3);

    markExtracted(db, "s1", 2);
    unext = getUnextracted(db, "s1", 10);
    expect(unext).toHaveLength(1);
    expect(unext[0].turn_index).toBe(3);
  });

  it("saveSignal + pendingSignals + markSignalsDone", () => {
    saveSignal(db, "s1", { type: "tool_error", turnIndex: 3, data: { snippet: "Error: xxx" } });
    saveSignal(db, "s1", { type: "task_completed", turnIndex: 5, data: { snippet: "done" } });

    let pending = pendingSignals(db, "s1");
    expect(pending).toHaveLength(2);
    expect(pending[0].type).toBe("tool_error");

    markSignalsDone(db, "s1");
    pending = pendingSignals(db, "s1");
    expect(pending).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 统计
// ═══════════════════════════════════════════════════════════════

describe("getStats", () => {
  it("正确统计节点和边", () => {
    const a = insertNode(db, { name: "skill-1", type: "SKILL" });
    const b = insertNode(db, { name: "task-1", type: "TASK" });
    insertEdge(db, { fromId: b, toId: a, type: "USED_SKILL" });

    const stats = getStats(db);
    expect(stats.totalNodes).toBe(2);
    expect(stats.byType["SKILL"]).toBe(1);
    expect(stats.byType["TASK"]).toBe(1);
    expect(stats.totalEdges).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// 按 session 查询
// ═══════════════════════════════════════════════════════════════

describe("getBySession", () => {
  it("精确匹配 session ID", () => {
    insertNode(db, { name: "node-s1", sessions: ["session-abc"] });
    insertNode(db, { name: "node-s2", sessions: ["session-xyz"] });

    const result = getBySession(db, "session-abc");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("node-s1");
  });
});
