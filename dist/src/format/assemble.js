/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */
import { getCommunitySummary, getEpisodicMessages, getNodeSourceMessages } from "../store/store.js";
const CHARS_PER_TOKEN = 3;
/**
 * 构建知识图谱的 system prompt 引导文字
 */
export function buildSystemPromptAddition(params) {
    const { selectedNodes, edgeCount, freshTurnCount } = params;
    if (selectedNodes.length === 0)
        return "";
    const recalledCount = selectedNodes.filter(n => n.src === "recalled").length;
    const hasRecalled = recalledCount > 0;
    const skillCount = selectedNodes.filter(n => n.type === "SKILL").length;
    const eventCount = selectedNodes.filter(n => n.type === "EVENT").length;
    const taskCount = selectedNodes.filter(n => n.type === "TASK").length;
    const isRich = selectedNodes.length >= 4 || edgeCount >= 3;
    const sections = [];
    sections.push("## Graph Memory — 知识图谱记忆", "", "Below `<knowledge_graph>` is your accumulated experience from past conversations.", "It contains structured knowledge — NOT raw conversation history.", "", `Current graph: ${skillCount} skills, ${eventCount} events, ${taskCount} tasks, ${edgeCount} relationships.`);
    if (hasRecalled) {
        sections.push("", `**${recalledCount} nodes recalled from OTHER conversations** — these are proven solutions that worked before.`, "Apply them directly when the current situation matches their trigger conditions.");
    }
    sections.push("", "## Recalled context for this query", "", "This is a context engine. The following was retrieved by semantic search for the current message:", "", "- **`<episodic_context>`** — Trimmed conversation traces from sessions that produced the knowledge nodes, ordered by time.", "- **`<knowledge_graph>`** — Relevant triples (TASK/SKILL/EVENT) and edges, grouped by community.", ...(freshTurnCount === undefined
        ? []
        : [`- **Recent ${freshTurnCount} turns** — retained verbatim by the active host context policy.`]), "", "Read this context first. Use `gm_search` only if insufficient. Use `gm_record` to save new knowledge.");
    if (isRich) {
        sections.push("", "**Graph navigation:** Edges show how knowledge connects:", "- `SOLVED_BY`: an EVENT was fixed by a SKILL — apply the skill when you see similar errors", "- `USED_SKILL`: a TASK used a SKILL — reuse the same approach for similar tasks", "- `PATCHES`: a newer SKILL corrects an older one — prefer the newer version", "- `CONFLICTS_WITH`: two SKILLs are mutually exclusive — check conditions before choosing");
    }
    return sections.join("\n");
}
/**
 * 组装知识图谱为 XML context
 */
export function assembleContext(db, params) {
    // Candidate collection is independent from injection. The token budget below
    // decides which relevant nodes enter this request.
    const map = new Map();
    for (const n of params.recalledNodes)
        map.set(n.id, { ...n, src: "recalled" });
    for (const n of params.activeNodes)
        map.set(n.id, { ...n, src: "active" });
    // 排序：本 session > 可复用技能/稳定事实 > 临时任务 > 可信度/PPR。
    // 对话记忆中的 EVENT 承载偏好、人物、项目状态和约定，不能因为
    // TASK 的结构类型而在紧张预算下先被挤掉。
    const TYPE_PRI = { SKILL: 3, EVENT: 2, TASK: 1 };
    const sorted = Array.from(map.values())
        .filter(n => n.status === "active")
        .sort((a, b) => (a.src === b.src ? 0 : a.src === "active" ? -1 : 1) ||
        (TYPE_PRI[b.type] ?? 0) - (TYPE_PRI[a.type] ?? 0) ||
        b.validatedCount - a.validatedCount ||
        b.pagerank - a.pagerank);
    const allEdges = [...params.activeEdges, ...params.recalledEdges];
    const budget = params.tokenBudget > 0 ? params.tokenBudget : Number.POSITIVE_INFINITY;
    let selected = sorted;
    let rendered;
    let systemPrompt = "";
    let baseTokens = 0;
    while (selected.length) {
        rendered = renderKnowledgeGraph(db, selected, allEdges);
        systemPrompt = buildSystemPromptAddition({
            selectedNodes: selected.map(n => ({ type: n.type, src: n.src })),
            edgeCount: rendered.edges.length,
            freshTurnCount: params.freshTurnCount,
        });
        baseTokens = Math.ceil((systemPrompt.length + rendered.xml.length) / CHARS_PER_TOKEN);
        if (baseTokens <= budget)
            break;
        selected = selected.slice(0, -1);
    }
    if (!selected.length || !rendered) {
        return { xml: null, systemPrompt: "", tokens: 0, episodicXml: "", episodicTokens: 0 };
    }
    const { xml } = rendered;
    // ── 溯源选拉：PPR top 3 节点 → 拉原始 user/assistant 对话 ──
    const topNodes = selected.slice(0, 3);
    const episodicParts = [];
    const emittedEvidence = new Set();
    let episodicCharsRemaining = Number.isFinite(budget)
        ? Math.max(0, Math.floor((budget - baseTokens) * CHARS_PER_TOKEN))
        : Number.POSITIVE_INFINITY;
    for (const node of topNodes) {
        if (episodicCharsRemaining <= 0)
            break;
        if (!node.sourceSessions?.length)
            continue;
        // 取最近的 2 个 session
        const recentSessions = node.sourceSessions.slice(-2);
        const traceBudget = Number.isFinite(episodicCharsRemaining)
            ? episodicCharsRemaining
            : 1500;
        const exact = getNodeSourceMessages(db, node.id, traceBudget);
        const msgs = exact.length
            ? exact
            : getEpisodicMessages(db, recentSessions, node.updatedAt, traceBudget);
        if (!msgs.length)
            continue;
        // Several graph nodes are often extracted from the same turn. Emit each
        // durable message once across all traces so one recalled conversation is
        // not multiplied by the number of matching nodes.
        const uniqueMsgs = msgs.filter((message) => {
            const key = `${message.sessionId}\u0000${message.turnIndex}\u0000${message.role}\u0000${message.text}`;
            if (emittedEvidence.has(key))
                return false;
            emittedEvidence.add(key);
            return true;
        });
        if (!uniqueMsgs.length)
            continue;
        const lines = uniqueMsgs.map(m => `    [${m.role.toUpperCase()}] ${escapeXml(m.text)}`).join("\n");
        const trace = `  <trace node="${node.name}">\n${lines}\n  </trace>`;
        if (trace.length > episodicCharsRemaining)
            break;
        episodicParts.push(trace);
        episodicCharsRemaining -= trace.length;
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
function renderKnowledgeGraph(db, selected, candidateEdges) {
    const idToName = new Map();
    for (const node of selected)
        idToName.set(node.id, node.name);
    const selectedIds = new Set(selected.map(node => node.id));
    const seen = new Set();
    const edges = candidateEdges.filter(edge => selectedIds.has(edge.fromId) && selectedIds.has(edge.toId) &&
        !seen.has(edge.id) && seen.add(edge.id));
    const byCommunity = new Map();
    const noCommunity = [];
    for (const node of selected) {
        if (node.communityId) {
            if (!byCommunity.has(node.communityId))
                byCommunity.set(node.communityId, []);
            byCommunity.get(node.communityId).push(node);
        }
        else {
            noCommunity.push(node);
        }
    }
    const xmlParts = [];
    for (const [communityId, members] of byCommunity) {
        const summary = getCommunitySummary(db, communityId);
        const label = summary ? escapeXml(summary.summary) : communityId;
        xmlParts.push(`  <community id="${communityId}" desc="${label}">`);
        for (const node of members)
            xmlParts.push(renderNode(node, "    "));
        xmlParts.push("  </community>");
    }
    for (const node of noCommunity)
        xmlParts.push(renderNode(node, "  "));
    const edgesXml = edges.length
        ? `\n  <edges>\n${edges.map(edge => {
            const fromName = idToName.get(edge.fromId) ?? edge.fromId;
            const toName = idToName.get(edge.toId) ?? edge.toId;
            const condition = edge.condition ? ` when="${escapeXml(edge.condition)}"` : "";
            return `    <e type="${edge.type}" from="${fromName}" to="${toName}"${condition}>${escapeXml(edge.instruction)}</e>`;
        }).join("\n")}\n  </edges>`
        : "";
    return {
        xml: `<knowledge_graph>\n${xmlParts.join("\n")}${edgesXml}\n</knowledge_graph>`,
        edges,
    };
}
function renderNode(node, indent) {
    const tag = node.type.toLowerCase();
    const source = node.src === "recalled" ? ` source="recalled"` : "";
    const updated = ` updated="${new Date(node.updatedAt).toISOString().slice(0, 10)}"`;
    return `${indent}<${tag} name="${node.name}" desc="${escapeXml(node.description)}"${source}${updated}>\n${node.content.trim()}\n${indent}</${tag}>`;
}
function escapeXml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
