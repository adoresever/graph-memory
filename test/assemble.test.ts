/**
 * graph-memory — 组装 + 消息修复测试
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import { createTestDb, insertNode, insertEdge } from "./helpers.ts";
import { assembleContext, buildSystemPromptAddition } from "../src/format/assemble.ts";
import { sanitizeToolUseResultPairing } from "../src/format/transcript-repair.ts";
import { findById } from "../src/store/store.ts";
import type { GmNode, GmEdge } from "../src/types.ts";

let db: DatabaseSyncInstance;

beforeEach(() => { db = createTestDb(); });

// ═══════════════════════════════════════════════════════════════
// buildSystemPromptAddition
// ═══════════════════════════════════════════════════════════════

describe("buildSystemPromptAddition", () => {
  it("空节点返回空字符串", () => {
    const result = buildSystemPromptAddition({ selectedNodes: [], edgeCount: 0 });
    expect(result).toBe("");
  });

  it("有节点返回引导文字", () => {
    const result = buildSystemPromptAddition({
      selectedNodes: [
        { type: "SKILL", src: "active" },
        { type: "EVENT", src: "recalled" },
      ],
      edgeCount: 2,
    });

    expect(result).toContain("Graph Memory");
    expect(result).toContain("1 nodes recalled from OTHER conversations");
  });

  it("丰富图谱包含导航说明", () => {
    const result = buildSystemPromptAddition({
      selectedNodes: [
        { type: "SKILL", src: "active" },
        { type: "SKILL", src: "active" },
        { type: "TASK", src: "active" },
        { type: "EVENT", src: "recalled" },
      ],
      edgeCount: 5,
    });

    expect(result).toContain("SOLVED_BY");
    expect(result).toContain("PATCHES");
  });
});

// ═══════════════════════════════════════════════════════════════
// assembleContext
// ═══════════════════════════════════════════════════════════════

describe("assembleContext", () => {
  it("有节点时生成 XML", () => {
    const id = insertNode(db, { name: "test-skill", type: "SKILL", content: "## test\nsome content" });
    const node = findById(db, id)!;

    const { xml, systemPrompt, tokens } = assembleContext(db, {
      tokenBudget: 128_000,
      activeNodes: [node],
      activeEdges: [],
      recalledNodes: [],
      recalledEdges: [],
    });

    expect(xml).toContain("<knowledge_graph>");
    expect(xml).toContain('name="test-skill"');
    expect(xml).toContain("</knowledge_graph>");
    expect(systemPrompt).toContain("Graph Memory");
    expect(tokens).toBeGreaterThan(0);
  });

  it("空节点返回 null", () => {
    const { xml, systemPrompt } = assembleContext(db, {
      tokenBudget: 128_000,
      activeNodes: [],
      activeEdges: [],
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
      tokenBudget: 128_000,
      activeNodes: [],
      activeEdges: [],
      recalledNodes: [node],
      recalledEdges: [],
    });

    expect(xml).toContain('source="recalled"');
  });

  it("token 预算不截断节点（全量放入）", () => {
    // 插入很多大节点
    const nodes: GmNode[] = [];
    for (let i = 0; i < 20; i++) {
      const id = insertNode(db, {
        name: `skill-${i}`,
        content: "x".repeat(5000), // 每个节点 5000 字符
      });
      nodes.push(findById(db, id)!);
    }

    // 很小的 token 预算
    const { xml } = assembleContext(db, {
      tokenBudget: 1000, // 1000 * 0.15 * 3 = 450 字符
      activeNodes: nodes,
      activeEdges: [],
      recalledNodes: [],
      recalledEdges: [],
    });

    // 不应该包含所有 20 个节点
    if (xml) {
      const matches = xml.match(/name="skill-/g);
      expect(matches!.length).toBe(20);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// sanitizeToolUseResultPairing
// ═══════════════════════════════════════════════════════════════

describe("sanitizeToolUseResultPairing", () => {
  it("正常配对不修改", () => {
    const msgs = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "bash" }] },
      { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "ok" }] },
    ];

    const result = sanitizeToolUseResultPairing(msgs);
    expect(result).toHaveLength(3);
  });

  it("缺失的 toolResult 被补充", () => {
    const msgs = [
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "bash" }] },
      // 缺少 toolResult for c1
      { role: "user", content: "next" },
    ];

    const result = sanitizeToolUseResultPairing(msgs);
    // 应该补一个 toolResult
    const toolResults = result.filter(m => m.role === "toolResult");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
  });

  it("孤立 toolResult 被移除", () => {
    const msgs = [
      { role: "toolResult", toolCallId: "orphan", content: [{ type: "text", text: "lost" }] },
      { role: "user", content: "hello" },
    ];

    const result = sanitizeToolUseResultPairing(msgs);
    expect(result.some(m => m.role === "toolResult")).toBe(false);
  });

  it("重复 toolResult 保持配对正确", () => {
    const msgs = [
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "bash" }] },
      { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "first" }] },
      { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "duplicate" }] },
      { role: "assistant", content: "next response" },
    ];

    const result = sanitizeToolUseResultPairing(msgs);
    // assistant 消息保留
    expect(result.filter(m => m.role === "assistant")).toHaveLength(2);
    // 至少有一个匹配的 toolResult
    const toolResults = result.filter(m => m.role === "toolResult");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    // 第一个 toolResult 的内容是 "first"
    expect((toolResults[0].content[0] as any).text).toBe("first");
  });
});