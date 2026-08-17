/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import type { GmNode, GmEdge } from "../types.ts";
import { getCommunitySummary, getEpisodicMessages } from "../store/store.ts";

const CHARS_PER_TOKEN = 3;

/**
 * 单节点 content 注入的最大字符数（0 = 不截断）。
 * 完整 content 始终可通过 gm_search 按需取回，注入端只需保留核心步骤/结论。
 */
export const DEFAULT_CONTENT_MAX_CHARS = 400;

/** 溯源（episodic）注入的收紧参数：top 节点数 / 单节点总字符 / 单条消息字符。 */
const EPISODIC_TOP_NODES = 2;
const EPISODIC_MAX_CHARS = 300;
const EPISODIC_MESSAGE_CHARS = 150;

/** XML 标签/属性等固定开销的粗略字符数，纳入节点 token 估算。 */
const NODE_XML_OVERHEAD_CHARS = 80;

/**
 * 估算单节点注入后的 token 数（name + description + content + XML 固定开销）。
 */
function estimateNodeTokens(n: GmNode): number {
  return Math.ceil(
    (n.name.length + n.description.length + n.content.length + NODE_XML_OVERHEAD_CHARS) / CHARS_PER_TOKEN,
  );
}

/**
 * 按字符上限截断 content 正文；截断时追加省略号以提示内容被裁剪。
 */
function clipBody(content: string, maxChars: number): string {
  const trimmed = content.trim();
  if (maxChars > 0 && trimmed.length > maxChars) {
    return `${trimmed.slice(0, maxChars)}…`;
  }
  return trimmed;
}

/**
 * 去掉 content 首行与节点 name 重复的内容。
 *
 * 提取模板让 content 首行以 `[name]`（或裸 name）开头，而 XML 标签已有 name 属性，
 * 首行是纯冗余。去掉后零信息损失，且对存量节点同样生效（无需迁移数据）。
 */
function stripLeadingName(content: string, name: string): string {
  const lines = content.split("\n");
  if (!lines.length) return content;
  const first = lines[0].trim();
  const bare = first.replace(/^\[|\]$/g, "").trim();
  if (first === name || bare === name) {
    return lines.slice(1).join("\n").trim();
  }
  return content;
}

/**
 * 生成节点正文：先去掉首行 name 冗余，再按上限截断，最后 XML 转义。
 */
function renderBody(n: GmNode, contentMaxChars: number): string {
  const stripped = stripLeadingName(n.content, n.name);
  return escapeXml(clipBody(stripped, contentMaxChars));
}

/**
 * 构建知识图谱的 system prompt 引导文字
 */
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

  const sections: string[] = [];

  sections.push(
    "## Graph Memory — 知识图谱记忆",
    "",
    "Below `<knowledge_graph>` is your accumulated experience from past conversations — structured knowledge, NOT raw history.",
    "",
    `Current graph: ${skillCount} skills, ${eventCount} events, ${taskCount} tasks, ${edgeCount} relationships.`,
  );

  if (hasRecalled) {
    sections.push(
      "",
      `**${recalledCount} nodes recalled from OTHER conversations** — proven solutions; apply directly when the situation matches their trigger conditions.`,
    );
  }

  sections.push(
    "",
    "## Recalled context for this query",
    "",
    "Retrieved by semantic search for the current message:",
    "",
    "- **`<episodic_context>`** — Trimmed conversation traces from sessions that produced the knowledge nodes.",
    "- **`<knowledge_graph>`** — Relevant triples (TASK/SKILL/EVENT) and edges, grouped by community.",
    "",
    "Read this first. Use `gm_search` if insufficient, `gm_record` to save new knowledge.",
  );

  if (isRich) {
    sections.push(
      "",
      "**Graph navigation:** `SOLVED_BY`=EVENT fixed by SKILL · `USED_SKILL`=TASK used SKILL · `PATCHES`=newer SKILL corrects older · `CONFLICTS_WITH`=mutually exclusive SKILLs.",
    );
  }

  return sections.join("\n");
}

/**
 * 组装知识图谱为 XML context
 *
 * tokenBudget > 0 时按预算贪心裁剪节点（已排序，优先级最高者先保留，至少保留 1 个）；
 * tokenBudget <= 0 时全量放入（向后兼容）。
 */
export function assembleContext(
  db: DatabaseSyncInstance,
  params: {
    tokenBudget: number;
    activeNodes: GmNode[];
    activeEdges: GmEdge[];
    recalledNodes: GmNode[];
    recalledEdges: GmEdge[];
    contentMaxChars?: number;
  },
): { xml: string | null; systemPrompt: string; tokens: number; episodicXml: string; episodicTokens: number } {
  const contentMaxChars = params.contentMaxChars ?? DEFAULT_CONTENT_MAX_CHARS;

  const map = new Map<string, GmNode & { src: "active" | "recalled" }>();
  for (const n of params.recalledNodes) map.set(n.id, { ...n, src: "recalled" });
  for (const n of params.activeNodes) map.set(n.id, { ...n, src: "active" });

  // 排序：本 session > SKILL优先 > validatedCount > 全局pagerank基线
  const TYPE_PRI: Record<string, number> = { SKILL: 3, TASK: 2, EVENT: 1 };
  const sorted = Array.from(map.values())
    .filter(n => n.status === "active")
    .sort((a, b) =>
      (a.src === b.src ? 0 : a.src === "active" ? -1 : 1) ||
      (TYPE_PRI[b.type] ?? 0) - (TYPE_PRI[a.type] ?? 0) ||
      b.validatedCount - a.validatedCount ||
      b.pagerank - a.pagerank
    );

  // ── 按 token 预算裁剪（0 = 不限制，向后兼容）────────────
  let selected = sorted;
  if (params.tokenBudget > 0) {
    const kept: typeof sorted = [];
    let used = 0;
    for (const n of sorted) {
      const cost = estimateNodeTokens(n);
      if (kept.length > 0 && used + cost > params.tokenBudget) break;
      kept.push(n);
      used += cost;
    }
    // 至少保留优先级最高的 1 个节点，即使单节点就超预算
    if (kept.length === 0 && sorted.length) kept.push(sorted[0]);
    selected = kept;
  }

  if (!selected.length) return { xml: null, systemPrompt: "", tokens: 0, episodicXml: "", episodicTokens: 0 };

  const idToName = new Map<string, string>();
  for (const n of selected) idToName.set(n.id, n.name);

  const selectedIds = new Set(selected.map(n => n.id));
  const allEdges = [...params.activeEdges, ...params.recalledEdges];
  const seen = new Set<string>();
  const edges = allEdges.filter(e =>
    selectedIds.has(e.fromId) && selectedIds.has(e.toId) && !seen.has(e.id) && seen.add(e.id)
  );

  // 按社区分组节点
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

  // 生成节点 XML（按社区分组）
  const xmlParts: string[] = [];

  for (const [cid, members] of byCommunity) {
    const summary = getCommunitySummary(db, cid);
    const label = summary ? escapeXml(summary.summary) : cid;
    xmlParts.push(`  <community id="${cid}" desc="${label}">`);
    for (const n of members) {
      const tag = n.type.toLowerCase();
      const srcAttr = n.src === "recalled" ? ` source="recalled"` : "";
      const body = renderBody(n, contentMaxChars);
      xmlParts.push(`    <${tag} name="${n.name}" desc="${escapeXml(n.description)}"${srcAttr}>\n${body}\n    </${tag}>`);
    }
    xmlParts.push(`  </community>`);
  }

  // 无社区的节点直接放顶层
  for (const n of noCommunity) {
    const tag = n.type.toLowerCase();
    const srcAttr = n.src === "recalled" ? ` source="recalled"` : "";
    const body = renderBody(n, contentMaxChars);
    xmlParts.push(`  <${tag} name="${n.name}" desc="${escapeXml(n.description)}"${srcAttr}>\n${body}\n  </${tag}>`);
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

  // ── 溯源选拉：PPR top N 节点 → 拉原始 user/assistant 对话 ──
  const topNodes = selected.slice(0, EPISODIC_TOP_NODES);
  const episodicParts: string[] = [];

  for (const node of topNodes) {
    if (!node.sourceSessions?.length) continue;
    // 取最近的 2 个 session
    const recentSessions = node.sourceSessions.slice(-2);
    const msgs = getEpisodicMessages(db, recentSessions, node.updatedAt, EPISODIC_MAX_CHARS);
    if (!msgs.length) continue;

    const lines = msgs.map(m =>
      `    [${m.role.toUpperCase()}] ${escapeXml(m.text.slice(0, EPISODIC_MESSAGE_CHARS))}`
    ).join("\n");
    episodicParts.push(`  <trace node="${node.name}">\n${lines}\n  </trace>`);
  }

  const episodicXml = episodicParts.length
    ? `<episodic_context>\n${episodicParts.join("\n")}\n</episodic_context>`
    : "";

  const fullContent = systemPrompt + "\n\n" + xml + (episodicXml ? "\n\n" + episodicXml : "");
  return {
    xml,
    systemPrompt,
    tokens: Math.ceil(fullContent.length / CHARS_PER_TOKEN),
    episodicXml,
    episodicTokens: Math.ceil(episodicXml.length / CHARS_PER_TOKEN),
  };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
