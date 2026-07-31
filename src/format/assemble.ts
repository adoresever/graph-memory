/**
 * graph-memory-pro — assemble.ts
 *
 * 基于原版，微调：getCommunitySummary 改为同步接收预加载数据
 * 因为 Neo4j 是异步的，assemble 在调用前预加载所有社区摘要
 */

import type { Driver } from "neo4j-driver";
import type { GmNode, GmEdge } from "../types.ts";
import { getCommunitySummary, getAllCommunitySummaries, type CommunitySummary } from "../store/store.ts";

const CHARS_PER_TOKEN = 3;

export function buildSystemPromptAddition(params: {
  selectedNodes: Array<{ type: string; src: "active" | "recalled" }>;
  edgeCount: number;
}): string {
  const { selectedNodes, edgeCount } = params;
  if (selectedNodes.length === 0) return "";

  const recalledCount = selectedNodes.filter(n => n.src === "recalled").length;
  const hasRecalled = recalledCount > 0;
  const skillCount = selectedNodes.filter(n => n.type === "SKILL").length;
  const eventCount = selectedNodes.filter(n => n.type === "EVENT").length;
  const taskCount = selectedNodes.filter(n => n.type === "TASK").length;
  const isRich = selectedNodes.length >= 4 || edgeCount >= 3;

  const parts: string[] = [];

  parts.push(
    "Graph Memory Pro — Knowledge Graph (Neo4j)",
    "",
    "Below <knowledge_graph> contains structured knowledge from past conversations.",
    `Graph: ${skillCount} skills, ${eventCount} events, ${taskCount} tasks, ${edgeCount} relationships.`,
  );

  if (hasRecalled) {
    parts.push(
      "",
      `${recalledCount} nodes recalled from other conversations — proven solutions. Apply directly when matching.`,
    );
  }

  parts.push(
    "",
    "Recall priority:",
    "1. Check <knowledge_graph> below first for matching Skill/Event nodes",
    "2. Use gm_search tool to find related nodes not shown below",
    "3. Use gm_record tool to save new discoveries",
    "4. The graph is your primary memory, not MEMORY.md",
  );

  if (isRich) {
    parts.push(
      "",
      "Edge meanings:",
      "SOLVED_BY: an Event was fixed by a Skill — apply it for similar errors",
      "USED_SKILL: a Task used a Skill — reuse for similar tasks",
      "PATCHES: newer Skill corrects older one — prefer newer",
      "CONFLICTS_WITH: two Skills are mutually exclusive — check conditions",
    );
  }

  return parts.join("\n");
}

/**
 * 组装知识图谱为 XML context
 *
 * 注意：driver 参数用于异步获取社区摘要
 */
export async function assembleContext(
  driver: Driver,
  params: {
    tokenBudget: number;
    activeNodes: GmNode[];
    activeEdges: GmEdge[];
    recalledNodes: GmNode[];
    recalledEdges: GmEdge[];
  },
): Promise<{ xml: string | null; systemPrompt: string; tokens: number }> {
  const maxChars = params.tokenBudget * 0.15 * CHARS_PER_TOKEN;

  // 合并去重
  const map = new Map<string, GmNode & { src: "active" | "recalled" }>();
  for (const n of params.recalledNodes) map.set(n.id, { ...n, src: "recalled" });
  for (const n of params.activeNodes) map.set(n.id, { ...n, src: "active" });

  const TYPE_PRI: Record<string, number> = { SKILL: 3, TASK: 2, EVENT: 1 };
  const sorted = Array.from(map.values())
    .filter(n => n.status === "active")
    .sort((a, b) =>
      (a.src === b.src ? 0 : a.src === "active" ? -1 : 1) ||
      (TYPE_PRI[b.type] ?? 0) - (TYPE_PRI[a.type] ?? 0) ||
      b.validatedCount - a.validatedCount ||
      b.pagerank - a.pagerank
    );

  const selected: typeof sorted = [];
  let used = 0;
  for (const n of sorted) {
    const sz = n.content.length + n.name.length + n.description.length + 50;
    if (used + sz > maxChars) break;
    selected.push(n);
    used += sz;
  }

  if (!selected.length) return { xml: null, systemPrompt: "", tokens: 0 };

  const idToName = new Map<string, string>();
  for (const n of selected) idToName.set(n.id, n.name);

  const selectedIds = new Set(selected.map(n => n.id));
  const allEdges = [...params.activeEdges, ...params.recalledEdges];
  const seen = new Set<string>();
  const edges = allEdges.filter(e =>
    selectedIds.has(e.fromId) && selectedIds.has(e.toId) && !seen.has(e.id) && seen.add(e.id)
  );

  // 预加载所有需要的社区摘要
  const communityIds = new Set(selected.map(n => n.communityId).filter(Boolean) as string[]);
  const communitySummaries = new Map<string, CommunitySummary>();
  for (const cid of communityIds) {
    const summary = await getCommunitySummary(driver, cid);
    if (summary) communitySummaries.set(cid, summary);
  }

  // 按社区分组
  const byCommunity = new Map<string, typeof selected>();
  const noCommunity: typeof selected = [];
  for (const n of selected) {
    if (n.communityId) {
      if (!byCommunity.has(n.communityId)) byCommunity.set(n.communityId, []);
      byCommunity.get(n.communityId)!.push(n);
    } else {
      noCommunity.push(n);
    }
  }

  const xmlParts: string[] = [];

  for (const [cid, members] of byCommunity) {
    const summary = communitySummaries.get(cid);
    const label = summary ? escapeXml(summary.summary) : cid;
    xmlParts.push(`  <community id="${cid}" desc="${label}">`);
    for (const n of members) {
      const tag = n.type.toLowerCase();
      const srcAttr = n.src === "recalled" ? ` source="recalled"` : "";
      const timeAttr = ` updated="${new Date(n.updatedAt).toISOString().slice(0, 10)}"`;
      xmlParts.push(`    <${tag} name="${n.name}" desc="${escapeXml(n.description)}"${srcAttr}${timeAttr}>\n${n.content.trim()}\n    </${tag}>`);
    }
    xmlParts.push(`  </community>`);
  }

  for (const n of noCommunity) {
    const tag = n.type.toLowerCase();
    const srcAttr = n.src === "recalled" ? ` source="recalled"` : "";
    const timeAttr = ` updated="${new Date(n.updatedAt).toISOString().slice(0, 10)}"`;
    xmlParts.push(`  <${tag} name="${n.name}" desc="${escapeXml(n.description)}"${srcAttr}${timeAttr}>\n${n.content.trim()}\n  </${tag}>`);
  }

  const nodesXml = xmlParts.join("\n");

  const edgesXml = edges.length
    ? `\n  <edges>\n${edges.map(e => {
        const fromName = idToName.get(e.fromId) ?? e.fromId;
        const toName = idToName.get(e.toId) ?? e.toId;
        const cond = e.condition ? ` when="${escapeXml(e.condition)}"` : "";
        return `    <e type="${e.type}" from="${fromName}" to="${toName}"${cond}>${escapeXml(e.instruction)}</e>`;
      }).join("\n")}\n  </edges>`
    : "";

  const xml = `<knowledge_graph>\n${nodesXml}${edgesXml}\n</knowledge_graph>`;

  const systemPrompt = buildSystemPromptAddition({
    selectedNodes: selected.map(n => ({ type: n.type, src: n.src })),
    edgeCount: edges.length,
  });

  const fullContent = systemPrompt + "\n\n" + xml;
  return { xml, systemPrompt, tokens: Math.ceil(fullContent.length / CHARS_PER_TOKEN) };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
