/**
 * graph-memory — 组装 + 消息修复测试
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync, type DatabaseSyncInstance } from "../src/store/sqlite.ts";
import { createTestDb, insertNode, insertEdge } from "./helpers.ts";
import { assembleContext, buildSystemPromptAddition } from "../src/format/assemble.ts";
import { findById, saveMessageOnce, upsertNode } from "../src/store/store.ts";
import type { GmNode, GmEdge } from "../src/types.ts";

let db: DatabaseSyncInstance;

beforeEach(() => { db = createTestDb(); });

// ═══════════════════════════════════════════════════════════════
// buildSystemPromptAddition
// ═══════════════════════════════════════════════════════════════

describe("buildSystemPromptAddition", () => {
  it("空节点返回空字符串", () => {
    const result = buildSystemPromptAddition({ hasMemory: false });
    expect(result).toBe("");
  });

  it("有节点返回引导文字", () => {
    const result = buildSystemPromptAddition({
      hasMemory: true,
    });

    expect(result).toContain("Graph Memory");
    expect(result).toContain("retrieved for the current user question");
  });

  it("引导词不随节点或边数量改变，便于宿主缓存", () => {
    const result = buildSystemPromptAddition({
      hasMemory: true,
    });

    const small = buildSystemPromptAddition({
      hasMemory: true,
    });
    expect(result).toBe(small);
  });
});

// ═══════════════════════════════════════════════════════════════
// assembleContext
// ═══════════════════════════════════════════════════════════════

describe("assembleContext", () => {
  it("有节点时生成 XML", () => {
    const id = insertNode(db, { name: "test-skill", type: "SKILL", content: "## test\nsome content" });
    const node = findById(db, id)!;

    const { xml, systemPrompt } = assembleContext(db, {
      recalledNodes: [node],
      recalledEdges: [],
    });

    expect(xml).toContain("<knowledge_graph>");
    expect(xml).toContain('name="test-skill"');
    expect(xml).toContain("</knowledge_graph>");
    expect(systemPrompt).toContain("Graph Memory");
  });

  it("renders evidence-backed temporal meaning into recalled context", () => {
    const node = upsertNode(db, {
      type: "EVENT",
      name: "release-port",
      description: "当前发布端口",
      content: "正式端口为 9090",
      temporal: { validFrom: "2026-09-10", state: "current" },
    }, "session-a").node;

    const { xml } = assembleContext(db, {
      recalledNodes: [node], recalledEdges: [],
    });

    expect(xml).toContain('validFrom="2026-09-10"');
    expect(xml).toContain('state="current"');
  });

  it("空节点返回 null", () => {
    const { xml, systemPrompt } = assembleContext(db, {
      recalledNodes: [],
      recalledEdges: [],
    });

    expect(xml).toBeNull();
    expect(systemPrompt).toBe("");
  });

  it("recalled 节点标记 source=recalled", () => {
    const id = insertNode(db, { name: "recalled-skill", type: "SKILL" });
    const node = findById(db, id)!;

    const { xml } = assembleContext(db, {
      recalledNodes: [node],
      recalledEdges: [],
    });

    expect(xml).toContain('source="recalled"');
  });

  it("不按字符猜测 Token，也不截断召回器已经选中的节点", () => {
    const nodes: GmNode[] = [];
    for (let i = 0; i < 20; i++) {
      const id = insertNode(db, {
        name: `skill-${i}`,
        content: "x".repeat(5000), // 每个节点 5000 字符
      });
      nodes.push(findById(db, id)!);
    }

    const { xml } = assembleContext(db, {
      recalledNodes: nodes,
      recalledEdges: [],
    });

    expect(xml).not.toBeNull();
    const matches = xml!.match(/name="skill-/g) ?? [];
    expect(matches).toHaveLength(20);
    expect(xml).toContain("x".repeat(5000));
  });

  it("preserves query relevance order for recalled nodes", () => {
    const answer = findById(db, insertNode(db, {
      name: "exact-final-answer", type: "EVENT", description: "exact query match", content: "FINAL=" + "a".repeat(300),
    }))!;
    const genericSkill = findById(db, insertNode(db, {
      name: "generic-skill", type: "SKILL", description: "generic", content: "SKILL=" + "b".repeat(300),
    }))!;

    const { xml } = assembleContext(db, {
      recalledNodes: [answer, genericSkill], recalledEdges: [],
    });

    expect(xml).toContain('name="exact-final-answer"');
    expect(xml!.indexOf('name="exact-final-answer"')).toBeLessThan(xml!.indexOf('name="generic-skill"'));
  });

  it("多个节点引用同一批原文时只注入一次证据", () => {
    saveMessageOnce(db, "m-user", "session-a", 1, "user", { content: "唯一用户事实" });
    saveMessageOnce(db, "m-assistant", "session-a", 2, "assistant", { content: "唯一助手确认" });
    const sources = [
      { messageId: "m-user", turnIndex: 1 },
      { messageId: "m-assistant", turnIndex: 2 },
    ];
    const first = upsertNode(db, {
      type: "EVENT", name: "shared-event", description: "shared", content: "fact",
    }, "session-a", sources).node;
    const second = upsertNode(db, {
      type: "TASK", name: "shared-task", description: "shared", content: "task",
    }, "session-a", sources).node;

    const { episodicXml } = assembleContext(db, {
      recalledNodes: [first, second], recalledEdges: [],
    });

    expect(episodicXml.match(/唯一用户事实/g)).toHaveLength(1);
    expect(episodicXml.match(/唯一助手确认/g)).toHaveLength(1);
    expect(episodicXml.match(/<trace /g)).toHaveLength(1);
  });
});
