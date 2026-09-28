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
  edgesFrom, edgesTo, allActiveNodes, allEdges,
  searchNodes, topNodes, graphWalk, getBySession, getRecentBySession,
  saveMessageOnce, getNextUnextractedTurn,
  getExtractionStats, markMessagesExtracted, quarantineMessages, requeueQuarantined,
  getNodeSourceMessages, markExtractionTurnCompleted, getExtractionCompletedTurn,
  getStats, saveVector, vectorSearch,
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
    expect((db.prepare("SELECT COUNT(*) AS count FROM gm_messages WHERE session_id=?").get("dsh:s1") as any).count).toBe(1);

    const { node } = upsertNode(db, {
      type: "EVENT", name: "nested-content", description: "", content: "summary",
    }, "dsh:s1", [{ messageId: "dsh:s1:7", turnIndex: 7 }]);
    const episodic = getNodeSourceMessages(db, node.id);
    expect(episodic).toHaveLength(1);
    expect(episodic[0].text).not.toContain("internal analysis");
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

    expect(getNodeSourceMessages(db, node.id).map(message => message.text)).toEqual([
      "the exact retained evidence",
    ]);
  });

  it("loads every node from the host-configured recent turn window", () => {
    saveMessageOnce(db, "m1", "dsh:s1", 1, "user", { content: "first" });
    saveMessageOnce(db, "m2", "dsh:s1", 2, "user", { content: "second" });
    const old = upsertNode(db, {
      type: "EVENT", name: "old-node", description: "", content: "old",
    }, "dsh:s1", [{ messageId: "m1", turnIndex: 1 }]).node;
    const recentA = upsertNode(db, {
      type: "EVENT", name: "recent-a", description: "", content: "a",
    }, "dsh:s1", [{ messageId: "m2", turnIndex: 2 }]).node;
    const recentB = upsertNode(db, {
      type: "TASK", name: "recent-b", description: "", content: "b",
    }, "dsh:s1", [{ messageId: "m2", turnIndex: 2 }]).node;

    expect(getRecentBySession(db, "dsh:s1", 3, 1).map(node => node.id).sort()).toEqual(
      [recentA.id, recentB.id].sort(),
    );
    expect(getRecentBySession(db, "dsh:s1", 3, 2).map(node => node.id)).toContain(old.id);
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

  it("同名 create 以当前结构化声明更新，不按文本长度裁决", () => {
    upsertNode(db, {
      type: "SKILL", name: "conda-env-create",
      description: "短描述", content: "短内容",
    }, "s1");

    const { node, isNew } = upsertNode(db, {
      type: "SKILL", name: "conda-env-create",
      description: "当前结论", content: "短而更新的结论",
    }, "s2");

    expect(isNew).toBe(false);
    expect(node.validatedCount).toBe(1);
    expect(node.description).toBe("当前结论");
    expect(node.content).toBe("短而更新的结论");
  });

  it("revise 用较新的短结论替换旧结论并重置旧置信计数", () => {
    upsertNode(db, {
      type: "EVENT", name: "project-port",
      description: "旧端口结论的较长描述", content: "此前错误地认为端口是 8080，附带很多旧过程说明",
      temporal: { eventTime: "上一轮", state: "current" },
    }, "s1");
    const { node } = upsertNode(db, {
      type: "EVENT", name: "project-port",
      description: "当前端口", content: "端口是 9090",
      operation: "revise",
      temporal: { eventTime: "本轮", state: "current" },
    }, "s1");

    expect(node.content).toBe("端口是 9090");
    expect(node.description).toBe("当前端口");
    expect(node.temporal).toEqual({ eventTime: "本轮", state: "current" });
    expect(node.validatedCount).toBe(1);
  });

  it("confirm 保留既有正文并增加验证次数", () => {
    upsertNode(db, {
      type: "EVENT", name: "release-day", description: "发布时间", content: "周五发布",
      temporal: { eventTime: "周五", state: "current" },
    }, "s1");
    const { node } = upsertNode(db, {
      type: "EVENT", name: "release-day", description: "短", content: "确认",
      operation: "confirm",
    }, "s2");

    expect(node.content).toBe("周五发布");
    expect(node.temporal).toEqual({ eventTime: "周五", state: "current" });
    expect(node.validatedCount).toBe(2);
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
    expect(after!.temporal.state).toBe("historical");
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
    // 明确的 confirm 才把 validated_count 提到 2；无 operation 的当前
    // 声明不能由存储层擅自当作确认。
    upsertNode(db, {
      type: "SKILL", name: "preserve-me",
      description: "d1", content: "c1",
      operation: "confirm",
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

// ═══════════════════════════════════════════════════════════════
// 边 CRUD
// ═══════════════════════════════════════════════════════════════

describe("edge CRUD", () => {
  it("stores a generic topic-navigation predicate", () => {
    const a = insertNode(db, { name: "graph-memory", type: "TASK" });
    const b = insertNode(db, { name: "completed-turn", type: "EVENT" });

    upsertEdge(db, {
      fromId: a, toId: b, type: "RELATES",
      instruction: "uses as extraction boundary", sessionId: "s1",
    });

    expect(edgesFrom(db, a)[0]).toMatchObject({
      toId: b,
      type: "RELATES",
      instruction: "uses as extraction boundary",
    });
  });

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
// 消息提取状态
// ═══════════════════════════════════════════════════════════════

describe("message extraction state", () => {
  it("hides active-turn messages behind the durable completion watermark", () => {
    saveMessageOnce(db, "done", "s1", 1, "assistant", "completed turn");
    saveMessageOnce(db, "active", "s1", 2, "user", "still generating");
    markExtractionTurnCompleted(db, "s1", 1);

    expect(getExtractionCompletedTurn(db, "s1")).toBe(1);
    expect(getNextUnextractedTurn(db, "s1", 1).map(row => row.id)).toEqual(["done"]);

    markExtractionTurnCompleted(db, "s1", 2);
    expect(getExtractionCompletedTurn(db, "s1")).toBe(2);
    expect(getNextUnextractedTurn(db, "s1", 2).map(row => row.id)).toEqual(["done"]);
    // A stale completion event can never move the watermark backwards.
    markExtractionTurnCompleted(db, "s1", 1);
    expect(getExtractionCompletedTurn(db, "s1")).toBe(2);
  });

  it("tracks exact extraction success and quarantine without crossing turn boundaries", () => {
    saveMessageOnce(db, "a", "s1", 1, "user", "first");
    saveMessageOnce(db, "b", "s1", 1, "tool", "same turn, different event");
    saveMessageOnce(db, "c", "s1", 2, "assistant", "third");

    markMessagesExtracted(db, ["b"]);
    quarantineMessages(db, ["a"], "poison input");
    expect(getExtractionStats(db)).toEqual({ pending: 1, succeeded: 1, quarantined: 1 });
    expect((db.prepare("SELECT extracted FROM gm_messages WHERE id='a'").get() as any).extracted).toBe(0);

    expect(requeueQuarantined(db, "s1")).toBe(1);
    expect(getExtractionStats(db)).toEqual({ pending: 2, succeeded: 1, quarantined: 0 });
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
