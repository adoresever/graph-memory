import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSyncInstance } from "../src/store/sqlite.ts";

import { assembleContext } from "../src/format/assemble.ts";
import { filterDshRecallMemories } from "../src/format/dsh-recall.ts";
import { Recaller } from "../src/recaller/recall.ts";
import { detectNavigationCommunities } from "../src/graph/community.ts";
import { personalizedNavigationPageRank } from "../src/graph/pagerank.ts";
import {
  findNavigationSeedTermIds,
  navigationCandidateTermIds,
  rankTurnMemoryIdsByNavigation,
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

  it("uses literal SPO seeds, local communities and PPR to recover source dialogue", async () => {
    const remember = (
      turn: number,
      summary: string,
      user: string,
      assistant: string,
      triple: { subject: string; predicate: string; object: string },
    ) => {
      const userId = `user-${turn}`;
      const assistantId = `assistant-${turn}`;
      saveMessageOnce(db, userId, "dsh:ppt", turn, "user", user);
      saveMessageOnce(db, assistantId, "dsh:ppt", turn, "assistant", assistant);
      const memory = upsertTurnMemory(db, {
        sessionId: "dsh:ppt",
        summary,
        outcome: "completed",
        sources: [
          { messageId: userId, turnIndex: turn },
          { messageId: assistantId, turnIndex: turn },
        ],
      });
      replaceNavigationTriples(db, memory, [triple]);
      return memory;
    };

    const deck = remember(
      1,
      "季度汇报演示文稿已采用品牌模板。",
      "把季度汇报 PPT 换成品牌模板",
      "已经换成品牌模板",
      { subject: "季度汇报 PPT", predicate: "使用", object: "品牌模板" },
    );
    const color = remember(
      2,
      "品牌模板主题色已调整为深海蓝。",
      "品牌模板换成深海蓝",
      "品牌模板主题色已经改为深海蓝",
      { subject: "品牌模板", predicate: "主题色", object: "深海蓝" },
    );
    remember(
      3,
      "晚餐选择了面条。",
      "晚上吃什么？",
      "选择了面条",
      { subject: "晚餐", predicate: "选择", object: "面条" },
    );
    detectNavigationCommunities(db);

    const recaller = new Recaller(db, { ...DEFAULT_CONFIG, recallMaxNodes: 2 });
    const recalled = await recaller.recall("深海蓝是什么模板的主题色？");

    expect(recalled.turnMemories.map(memory => memory.id)).toEqual([color.id, deck.id]);
    expect(recalled.triples.map(triple => triple.object)).toEqual(expect.arrayContaining([
      "品牌模板",
      "深海蓝",
    ]));
    expect(recalled.triples).toHaveLength(2);
    expect(recalled.triples.some(triple => triple.subject === "晚餐")).toBe(false);

    const assembled = assembleContext(db, {
      recalledMemories: recalled.turnMemories,
      recalledNodes: [],
      recalledEdges: [],
      recalledTriples: recalled.triples,
    });
    expect(assembled.episodicXml).toContain("把季度汇报 PPT 换成品牌模板");
    expect(assembled.episodicXml).toContain("品牌模板主题色已经改为深海蓝");
    expect(assembled.episodicXml).not.toContain("晚上吃什么");
  });

  it("does not mix weaker summary communities into an exact SPO route", () => {
    const remember = (
      turn: number,
      summary: string,
      triple: { subject: string; predicate: string; object: string },
    ) => {
      const userId = `priority-user-${turn}`;
      const assistantId = `priority-assistant-${turn}`;
      saveMessageOnce(db, userId, "dsh:priority", turn, "user", `问题 ${turn}`);
      saveMessageOnce(db, assistantId, "dsh:priority", turn, "assistant", `回答 ${turn}`);
      const memory = upsertTurnMemory(db, {
        sessionId: "dsh:priority",
        summary,
        outcome: "completed",
        sources: [
          { messageId: userId, turnIndex: turn },
          { messageId: assistantId, turnIndex: turn },
        ],
      });
      replaceNavigationTriples(db, memory, [triple]);
      return memory;
    };
    const exact = remember(1, "品牌模板主题色是深海蓝。", {
      subject: "品牌模板",
      predicate: "主题色",
      object: "深海蓝",
    });
    const weak = remember(2, "团队晚餐选择了面条。", {
      subject: "团队晚餐",
      predicate: "选择",
      object: "面条",
    });
    detectNavigationCommunities(db);

    const seeds = findNavigationSeedTermIds(db, "深海蓝是什么模板的主题色？", [weak.id]);
    const candidates = navigationCandidateTermIds(db, seeds);
    const scores = personalizedNavigationPageRank(db, seeds, candidates, DEFAULT_CONFIG).scores;
    expect(rankTurnMemoryIdsByNavigation(db, scores)).toContain(exact.id);
    expect(rankTurnMemoryIdsByNavigation(db, scores)).not.toContain(weak.id);
  });

  it("prefers a specific compound navigation term over its generic hub", () => {
    const add = (
      turn: number,
      summary: string,
      triple: { subject: string; predicate: string; object: string },
    ) => {
      const userId = `specific-user-${turn}`;
      const assistantId = `specific-assistant-${turn}`;
      saveMessageOnce(db, userId, "dsh:specific", turn, "user", `问题 ${turn}`);
      saveMessageOnce(db, assistantId, "dsh:specific", turn, "assistant", `回答 ${turn}`);
      const memory = upsertTurnMemory(db, {
        sessionId: "dsh:specific",
        summary,
        outcome: "completed",
        sources: [
          { messageId: userId, turnIndex: turn },
          { messageId: assistantId, turnIndex: turn },
        ],
      });
      replaceNavigationTriples(db, memory, [triple]);
      return memory;
    };
    const exact = add(1, "为 ReleaseOrchestrator addService 增加依赖支持。", {
      subject: "ReleaseOrchestrator addService",
      predicate: "支持",
      object: "dependencies",
    });
    add(2, "ReleaseOrchestrator 的负责人是唐宁。", {
      subject: "ReleaseOrchestrator",
      predicate: "负责人",
      object: "唐宁",
    });
    detectNavigationCommunities(db);

    const seeds = findNavigationSeedTermIds(db, "ReleaseOrchestrator addService", []);
    const labels = seeds.map(id => db.prepare(
      "SELECT display_text FROM gm_navigation_terms WHERE id=?",
    ).get(id) as { display_text: string });
    expect(labels.map(row => row.display_text)).toEqual(["ReleaseOrchestrator addService"]);
    const scores = personalizedNavigationPageRank(
      db,
      seeds,
      navigationCandidateTermIds(db, seeds),
      DEFAULT_CONFIG,
    ).scores;
    expect(rankTurnMemoryIdsByNavigation(db, scores)[0]).toBe(exact.id);
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
