import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSyncInstance } from "../src/store/sqlite.ts";

import { assembleContext } from "../src/format/assemble.ts";
import { filterDshRecallMemories } from "../src/format/dsh-recall.ts";
import { Recaller } from "../src/recaller/recall.ts";
import { detectNavigationCommunities } from "../src/graph/community.ts";
import {
  saveMessageOnce,
  replaceNavigationTriples,
  getRecentTurnMemoriesBySession,
  saveTurnVector,
  saveVector,
  upsertNode,
  upsertTurnMemory,
} from "../src/store/store.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import { createTestDb } from "./helpers.ts";

let db: DatabaseSyncInstance;

beforeEach(() => {
  db = createTestDb();
});

function sourcePair(sessionId = "dsh:session-a") {
  saveMessageOnce(db, "user-1", sessionId, 1, "user", "请修复发布端口配置");
  saveMessageOnce(db, "assistant-1", sessionId, 1, "assistant", "已修复并验证端口为 9090");
  return [
    { messageId: "user-1", turnIndex: 1 },
    { messageId: "assistant-1", turnIndex: 1 },
  ];
}

describe("layered turn memory", () => {
  it("provides only earlier same-session summaries for reference resolution", () => {
    saveMessageOnce(db, "user-a", "dsh:session-a", 1, "user", "先处理季度报告");
    saveMessageOnce(db, "assistant-a", "dsh:session-a", 1, "assistant", "季度报告已完成初稿");
    upsertTurnMemory(db, {
      sessionId: "dsh:session-a",
      summary: "季度报告已完成初稿。",
      outcome: "completed",
      sources: [{ messageId: "user-a", turnIndex: 1 }, { messageId: "assistant-a", turnIndex: 1 }],
    });
    saveMessageOnce(db, "user-b", "dsh:session-a", 2, "user", "继续这个");
    saveMessageOnce(db, "assistant-b", "dsh:session-a", 2, "assistant", "数据复核已完成");
    upsertTurnMemory(db, {
      sessionId: "dsh:session-a",
      summary: "季度报告初稿已完成数据复核。",
      outcome: "completed",
      sources: [{ messageId: "user-b", turnIndex: 2 }, { messageId: "assistant-b", turnIndex: 2 }],
    });

    expect(getRecentTurnMemoriesBySession(db, "dsh:session-a", 3, 1)
      .map(memory => memory.summary)).toEqual(["季度报告初稿已完成数据复核。"]);
    expect(getRecentTurnMemoriesBySession(db, "dsh:session-a", 2, 5)
      .map(memory => memory.summary)).toEqual(["季度报告已完成初稿。"]);
    expect(getRecentTurnMemoriesBySession(db, "dsh:other", 3, 5)).toEqual([]);
  });

  it("stores one compact summary with its complete durable Q/A evidence", () => {
    const sources = sourcePair();
    const first = upsertTurnMemory(db, {
      sessionId: "dsh:session-a",
      summary: "用户要求修复发布端口，最终回答确认已修复并验证为 9090。",
      outcome: "completed",
      sources,
    });
    const revised = upsertTurnMemory(db, {
      sessionId: "dsh:session-a",
      summary: "发布端口已修复并验证为 9090。",
      outcome: "completed",
      sources,
    });

    expect(revised.id).toBe(first.id);
    expect(revised.summary).toContain("9090");
    expect(revised.sources).toEqual(sources);
    expect((db.prepare("SELECT COUNT(*) AS count FROM gm_turn_memories").get() as any).count).toBe(1);
  });

  it("retrieves a compact summary first, then resolves SPO navigation and exact evidence", async () => {
    const sources = sourcePair();
    const memory = upsertTurnMemory(db, {
      sessionId: "dsh:session-a",
      summary: "用户要求修复发布端口，最终回答确认已修复并验证为 9090。",
      outcome: "completed",
      sources,
    });
    replaceNavigationTriples(db, memory, [{
      subject: "发布端口",
      predicate: "验证为",
      object: "9090",
    }]);
    saveTurnVector(db, memory.id, memory.summary, [1, 0]);

    const recaller = new Recaller(db, {
      ...DEFAULT_CONFIG,
      semanticScoreThreshold: 0.8,
    });
    recaller.setEmbedFn(async () => [1, 0]);
    const recalled = await recaller.recall("之前修好的发布端口是多少？");

    expect(recalled.turnMemories.map(item => item.id)).toEqual([memory.id]);
    expect(recalled.nodes).toEqual([]);
    expect(recalled.triples).toMatchObject([{
      memoryId: memory.id,
      subject: "发布端口",
      predicate: "验证为",
      object: "9090",
    }]);

    const assembled = assembleContext(db, {
      recalledMemories: recalled.turnMemories,
      recalledNodes: recalled.nodes,
      recalledEdges: recalled.edges,
      recalledTriples: recalled.triples,
    });
    expect(assembled.memoryXml).toContain("发布端口");
    expect(assembled.xml).toContain("<navigation_graph>");
    expect(assembled.xml).toContain("<subject>发布端口</subject>");
    expect(assembled.episodicXml).toContain("请修复发布端口配置");
    expect(assembled.episodicXml).toContain("已修复并验证端口为 9090");
  });

  it("builds communities from summary-derived navigation terms", () => {
    const memory = upsertTurnMemory(db, {
      sessionId: "dsh:session-a",
      summary: "周会已改到周四。",
      outcome: "completed",
      sources: sourcePair(),
    });
    replaceNavigationTriples(db, memory, [{ subject: "周会", predicate: "改到", object: "周四" }]);

    const result = detectNavigationCommunities(db);
    expect(result.count).toBe(1);
    const terms = db.prepare(
      "SELECT display_text, community_id FROM gm_navigation_terms ORDER BY display_text",
    ).all() as Array<{ display_text: string; community_id: string }>;
    expect(new Set(terms.map(term => term.community_id)).size).toBe(1);
  });

  it("does not let a covered graph node bypass a rejected summary", async () => {
    const sources = sourcePair();
    const memory = upsertTurnMemory(db, {
      sessionId: "dsh:session-a",
      summary: "发布端口已修复并验证为 9090。",
      outcome: "completed",
      sources,
    });
    const node = upsertNode(db, {
      type: "EVENT",
      name: "release-port",
      description: "当前发布端口",
      content: "发布端口已验证为 9090",
    }, "dsh:session-a", sources).node;
    saveTurnVector(db, memory.id, memory.summary, [0.4, Math.sqrt(1 - 0.4 ** 2)]);
    // Even if a stale node vector looks close, a node already represented by
    // a capsule must not bypass the capsule-level confidence decision.
    saveVector(db, node.id, node.content, [1, 0]);

    const recaller = new Recaller(db, {
      ...DEFAULT_CONFIG,
      semanticScoreThreshold: 0.8,
    });
    recaller.setEmbedFn(async () => [1, 0]);
    const recalled = await recaller.recall("今天晚餐吃什么？");

    expect(recalled.turnMemories).toEqual([]);
    expect(recalled.nodes).toEqual([]);
    expect(recalled.edges).toEqual([]);
  });

  it("does not replay a same-session capsule whose full Q/A remains visible", () => {
    const memory = upsertTurnMemory(db, {
      sessionId: "dsh:session-a",
      summary: "发布端口已修复。",
      outcome: "completed",
      sources: sourcePair(),
    });

    expect(filterDshRecallMemories(
      [memory],
      "dsh:session-a",
      new Set(["user-1", "assistant-1"]),
    )).toEqual([]);
    expect(filterDshRecallMemories(
      [memory],
      "dsh:other-session",
      new Set(),
    )).toEqual([memory]);
  });
});
