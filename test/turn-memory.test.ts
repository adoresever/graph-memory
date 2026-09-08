import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSyncInstance } from "../src/store/sqlite.ts";

import { assembleContext } from "../src/format/assemble.ts";
import { filterDshRecallMemories } from "../src/format/dsh-recall.ts";
import { Recaller } from "../src/recaller/recall.ts";
import {
  saveMessageOnce,
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

  it("retrieves a compact summary first, then resolves its graph and exact evidence", async () => {
    const sources = sourcePair();
    const memory = upsertTurnMemory(db, {
      sessionId: "dsh:session-a",
      summary: "用户要求修复发布端口，最终回答确认已修复并验证为 9090。",
      outcome: "completed",
      sources,
    });
    const node = upsertNode(db, {
      type: "EVENT",
      name: "release-port",
      description: "当前发布端口",
      content: "发布端口已验证为 9090",
    }, "dsh:session-a", sources).node;
    saveTurnVector(db, memory.id, memory.summary, [1, 0]);
    saveVector(db, node.id, node.content, [0, 1]);

    const recaller = new Recaller(db, {
      ...DEFAULT_CONFIG,
      semanticScoreThreshold: 0.8,
    });
    recaller.setEmbedFn(async () => [1, 0]);
    const recalled = await recaller.recall("之前修好的发布端口是多少？");

    expect(recalled.turnMemories.map(item => item.id)).toEqual([memory.id]);
    expect(recalled.nodes.map(item => item.id)).toEqual([node.id]);

    const assembled = assembleContext(db, {
      recalledMemories: recalled.turnMemories,
      recalledNodes: recalled.nodes,
      recalledEdges: recalled.edges,
    });
    expect(assembled.memoryXml).toContain("发布端口");
    expect(assembled.xml).toContain('name="release-port"');
    expect(assembled.episodicXml).toContain("请修复发布端口配置");
    expect(assembled.episodicXml).toContain("已修复并验证端口为 9090");
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
