/**
 * format/assemble 集成测试 — 移植自原 test/assemble.test.ts
 *
 * 覆盖：buildSystemPromptAddition 各分支 + assembleContext XML 生成 +
 *       token 预算控制 + 边过滤
 *
 * buildSystemPromptAddition 是纯函数（不需要 driver），但为了与
 * assembleContext 一起覆盖，统一在集成测试套件中跑。
 *
 * 运行：NEO4J_INTEGRATION=1 npm test -- test/integration.assemble.test.ts
 */

import { describe, it, expect } from "vitest";
import { buildSystemPromptAddition, assembleContext } from "../src/format/assemble.ts";
import type { GmNode, GmEdge } from "../src/types.ts";

const ENABLED = !!process.env.NEO4J_INTEGRATION;

function makeNode(over: Partial<GmNode>): GmNode {
  return {
    id: over.id ?? `n-${Math.random().toString(36).slice(2, 8)}`,
    type: over.type ?? "SKILL",
    name: over.name ?? "skill-name",
    description: over.description ?? "desc",
    content: over.content ?? "content body",
    status: over.status ?? "active",
    tier: over.tier ?? "working",
    validatedCount: over.validatedCount ?? 1,
    sourceSessions: over.sourceSessions ?? ["s1"],
    communityId: over.communityId ?? null,
    pagerank: over.pagerank ?? 0,
    createdAt: over.createdAt ?? Date.now(),
    updatedAt: over.updatedAt ?? Date.now(),
    lastAccessedAt: over.lastAccessedAt ?? Date.now(),
  };
}

function makeEdge(over: Partial<GmEdge>): GmEdge {
  return {
    id: over.id ?? `e-${Math.random().toString(36).slice(2, 8)}`,
    fromId: over.fromId ?? "n-from",
    toId: over.toId ?? "n-to",
    type: over.type ?? "USED_SKILL",
    instruction: over.instruction ?? "uses",
    condition: over.condition,
    sessionId: over.sessionId ?? "s1",
    createdAt: over.createdAt ?? Date.now(),
  };
}

describe.skipIf(!ENABLED)("format/assemble integration", () => {
  describe("buildSystemPromptAddition", () => {
    it("空 selectedNodes 返回空字符串", () => {
      expect(buildSystemPromptAddition({ selectedNodes: [], edgeCount: 0 })).toBe("");
    });

    it("含 recalled 节点时输出召回提示", () => {
      const result = buildSystemPromptAddition({
        selectedNodes: [
          { type: "SKILL", src: "active" },
          { type: "EVENT", src: "recalled" },
        ],
        edgeCount: 2,
      });
      expect(result).toContain("Graph Memory Pro");
      expect(result).toContain("recalled from other conversations");
    });

    it("节点 >=4 或 edges >=3 触发丰富图谱分支说明", () => {
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
      expect(result).toContain("CONFLICTS_WITH");
    });

    it("节点少且无 recalled 时不输出召回提示", () => {
      const result = buildSystemPromptAddition({
        selectedNodes: [{ type: "SKILL", src: "active" }],
        edgeCount: 0,
      });
      expect(result).not.toContain("recalled from other conversations");
    });
  });

  describe("assembleContext", () => {
    it("空 active 与 recalled 返回 null xml", async () => {
      // assembleContext 需要 driver 查社区摘要；这里用 null cast 绕过类型，
      // 因为没有节点 → 不会触发 driver 调用
      const result = await assembleContext(null as any, {
        tokenBudget: 1000,
        activeNodes: [],
        activeEdges: [],
        recalledNodes: [],
        recalledEdges: [],
      });
      expect(result.xml).toBeNull();
      expect(result.systemPrompt).toBe("");
      expect(result.tokens).toBe(0);
    });

    it("生成 XML 并按 type 优先级排序（SKILL > TASK > EVENT）", async () => {
      const event = makeNode({ id: "evt-1", type: "EVENT", name: "evt" });
      const task = makeNode({ id: "task-1", type: "TASK", name: "task" });
      const skill = makeNode({ id: "skill-1", type: "SKILL", name: "skill" });

      const result = await assembleContext(null as any, {
        tokenBudget: 4000,
        activeNodes: [event, task, skill],
        activeEdges: [],
        recalledNodes: [],
        recalledEdges: [],
      });

      expect(result.xml).not.toBeNull();
      expect(result.xml).toContain("<knowledge_graph>");
      expect(result.xml).toContain("<skill name=\"skill\"");
      expect(result.xml).toContain("<task name=\"task\"");
      expect(result.xml).toContain("<event name=\"evt\"");

      // SKILL 应排在最前
      const skillPos = result.xml!.indexOf("<skill ");
      const taskPos = result.xml!.indexOf("<task ");
      const eventPos = result.xml!.indexOf("<event ");
      expect(skillPos).toBeLessThan(taskPos);
      expect(taskPos).toBeLessThan(eventPos);

      expect(result.systemPrompt).toContain("Graph Memory Pro");
      expect(result.tokens).toBeGreaterThan(0);
    });

    it("recalled 节点带 source=\"recalled\" 属性", async () => {
      const recalled = makeNode({ id: "rec-1", type: "SKILL", name: "recalled-skill" });
      const result = await assembleContext(null as any, {
        tokenBudget: 2000,
        activeNodes: [],
        activeEdges: [],
        recalledNodes: [recalled],
        recalledEdges: [],
      });
      expect(result.xml).toContain('source="recalled"');
    });

    it("XML 转义：description 含 < > & \" 时正确转义", async () => {
      const n = makeNode({
        id: "esc-1", type: "SKILL", name: "escape-test",
        description: `a <b> & "c" > d`,
      });
      const result = await assembleContext(null as any, {
        tokenBudget: 2000,
        activeNodes: [n],
        activeEdges: [],
        recalledNodes: [],
        recalledEdges: [],
      });
      expect(result.xml).toContain("&lt;b&gt;");
      expect(result.xml).toContain("&amp;");
      expect(result.xml).toContain("&quot;c&quot;");
    });

    it("token 预算：低预算时截断到少量节点", async () => {
      // maxChars = 500 * 0.15 * 3 = 225；每节点 content 100 + name/desc + 50 ≈ 165 字符
      // 第一个塞下（165<225），第二个塞不下（330>225）→ 截断
      const nodes = Array.from({ length: 5 }, (_, i) =>
        makeNode({ id: `big-${i}`, type: "SKILL", name: `big-${i}`, content: "x".repeat(100) })
      );
      const result = await assembleContext(null as any, {
        tokenBudget: 500,
        activeNodes: nodes,
        activeEdges: [],
        recalledNodes: [],
        recalledEdges: [],
      });
      expect(result.xml).not.toBeNull();
      const skillCount = (result.xml!.match(/<skill /g) || []).length;
      expect(skillCount).toBeGreaterThanOrEqual(1);
      expect(skillCount).toBeLessThan(5);
    });

    it("边过滤：只保留 selectedIds 内的双端边", async () => {
      const a = makeNode({ id: "edge-a", type: "SKILL", name: "a" });
      const b = makeNode({ id: "edge-b", type: "SKILL", name: "b" });
      const orphanEdge = makeEdge({ id: "orphan", fromId: "edge-a", toId: "ghost-not-selected", type: "USED_SKILL" });
      const validEdge = makeEdge({ id: "valid", fromId: "edge-a", toId: "edge-b", type: "USED_SKILL" });

      const result = await assembleContext(null as any, {
        tokenBudget: 4000,
        activeNodes: [a, b],
        activeEdges: [validEdge, orphanEdge],
        recalledNodes: [],
        recalledEdges: [],
      });
      expect(result.xml).toContain("<edges>");
      expect(result.xml).toContain("from=\"a\" to=\"b\"");
      expect(result.xml).not.toContain("ghost-not-selected");
    });

    it("deprecated 节点被过滤（不输出）", async () => {
      const active = makeNode({ id: "act-1", type: "SKILL", name: "active-node" });
      const deprecated = makeNode({ id: "dep-1", type: "SKILL", name: "dep-node", status: "deprecated" });

      const result = await assembleContext(null as any, {
        tokenBudget: 4000,
        activeNodes: [active, deprecated],
        activeEdges: [],
        recalledNodes: [],
        recalledEdges: [],
      });
      expect(result.xml).toContain("active-node");
      expect(result.xml).not.toContain("dep-node");
    });
  });
});
