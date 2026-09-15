/**
 * graph-memory-pro — 社区检测 (Neo4j GDS)
 *
 * 替代原版手写的 Label Propagation 算法
 * 使用 GDS gds.labelPropagation
 * 保留 summarizeCommunities()（需要 LLM）
 */

import { createHash } from "node:crypto";
import type { Driver } from "neo4j-driver";
import { getSession } from "../store/db.ts";
import {
  clearCommunities,
  updateCommunities,
  upsertCommunitySummary,
  getCommunitySummary,
  getCommunitySummaryBySignature,
  pruneCommunitySummaries,
} from "../store/store.ts";
import { getExistingActiveRelTypes, projectActiveGraph } from "./projection.ts";
import { stripThinkTags } from "../engine/llm.ts";

export interface CommunityResult {
  labels: Map<string, string>;
  communities: Map<string, string[]>;
  count: number;
}

/**
 * 社区检测 — 使用 GDS labelPropagation
 */
export async function detectCommunities(driver: Driver, maxIter = 50): Promise<CommunityResult> {
  const session = getSession(driver);
  const graphName = `gm-community-${Date.now()}`;

  try {
    // 检查节点数
    const countResult = await session.run(
      "MATCH (n:Task|Skill|Event {status: 'active'}) RETURN count(n) AS c"
    );
    const nodeCount = countResult.records[0]?.get("c")?.toNumber?.() ?? 0;
    if (nodeCount === 0) {
      await clearCommunities(driver);
      return { labels: new Map(), communities: new Map(), count: 0 };
    }

    const existingTypes = await getExistingActiveRelTypes(session);
    if (existingTypes.length === 0) {
      await clearCommunities(driver);
      return { labels: new Map(), communities: new Map(), count: 0 };
    }

    await projectActiveGraph(session, graphName, existingTypes);

    // 运行 Label Propagation
    const lpResult = await session.run(`
      CALL gds.labelPropagation.stream('${graphName}', {
        maxIterations: toInteger($maxIter)
      })
      YIELD nodeId, communityId
      WITH gds.util.asNode(nodeId) AS node, communityId
      WHERE node.status = 'active'
      RETURN node.id AS id, toString(communityId) AS rawCommunityId
    `, { maxIter });

    // 清理图投影
    await session.run(`CALL gds.graph.drop('${graphName}')`);


    // 构建社区映射
    const rawLabels = new Map<string, string>();
    const rawCommunities = new Map<string, string[]>();

    for (const r of lpResult.records) {
      const nodeId = r.get("id");
      const rawCid = r.get("rawCommunityId");
      rawLabels.set(nodeId, rawCid);
      if (!rawCommunities.has(rawCid)) rawCommunities.set(rawCid, []);
      rawCommunities.get(rawCid)!.push(nodeId);
    }

    // 按成员数排序，重新编号 c-1, c-2, ...
    const sorted = Array.from(rawCommunities.entries())
      .sort((a, b) => b[1].length - a[1].length);

    const renameMap = new Map<string, string>();
    sorted.forEach(([oldId], i) => renameMap.set(oldId, `c-${i + 1}`));

    const finalLabels = new Map<string, string>();
    for (const [nodeId, oldLabel] of rawLabels) {
      finalLabels.set(nodeId, renameMap.get(oldLabel) || oldLabel);
    }

    const finalCommunities = new Map<string, string[]>();
    for (const [oldId, members] of rawCommunities) {
      finalCommunities.set(renameMap.get(oldId) || oldId, members);
    }

    // 写回数据库
    await updateCommunities(driver, finalLabels);

    return {
      labels: finalLabels,
      communities: finalCommunities,
      count: finalCommunities.size,
    };
  } catch {
    try { await session.run("CALL gds.graph.drop($graphName)", { graphName }); } catch {}
    return { labels: new Map(), communities: new Map(), count: 0 };
  } finally {
    await session.close();
  }
}

/**
 * 获取同社区的节点 ID 列表
 */
export async function getCommunityPeers(driver: Driver, nodeId: string, limit = 5): Promise<string[]> {
  const session = getSession(driver);
  try {
    const result = await session.run(`
      MATCH (n:Task|Skill|Event {id: $nodeId, status: 'active'})
      WITH n.communityId AS cid
      WHERE cid IS NOT NULL
      MATCH (peer:Task|Skill|Event {communityId: cid, status: 'active'})
      WHERE peer.id <> $nodeId
      RETURN peer.id AS id
      ORDER BY peer.validatedCount DESC, peer.updatedAt DESC
      LIMIT toInteger($limit)
    `, { nodeId, limit });
    return result.records.map(r => r.get("id"));
  } finally {
    await session.close();
  }
}

// ─── 社区描述生成（保留原版逻辑，改为 async + Neo4j） ────────

import type { CompleteFn } from "../engine/llm.ts";
import type { EmbedFn } from "../engine/embed.ts";

const COMMUNITY_SUMMARY_SYS = `你是知识图谱社区摘要引擎。根据社区内的节点列表，生成一句话描述该社区的主题领域。
要求：
- 只返回一句话，不超过 30 个字
- 描述该社区涵盖的工具/技术/任务领域
- 不要使用"社区"这个词
- 不要加引号或标点以外的格式`;

export function buildCommunityMemberSignature(memberIds: string[]): string {
  return createHash("sha1").update([...memberIds].sort().join(",")).digest("hex");
}

/**
 * top-k 稳定签名（LLM 成本控制）：取 validatedCount 最高的 k 个成员计算签名，
 * 而非全量成员集合。社区边界抖动（每次微增/减一个低频成员）不再触发 LLM 重摘要——
 * 摘要语义本就由高价值成员主导。成员数 ≤ k 时退化为全量签名（与旧格式一致）。
 * 并列的 validatedCount 用 id 字典序决胜负，保证确定性。
 */
export const COMMUNITY_SIGNATURE_TOP_K = 8;

export function buildTopKMemberSignature(
  members: Array<{ id: string; validatedCount: number }>,
  k: number = COMMUNITY_SIGNATURE_TOP_K,
): string {
  const top = [...members]
    .sort((a, b) =>
      b.validatedCount - a.validatedCount ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, Math.max(1, k))
    .map((m) => m.id)
    .sort();
  return createHash("sha1").update(top.join(",")).digest("hex");
}

export async function summarizeCommunities(
  driver: Driver,
  communities: Map<string, string[]>,
  llm: CompleteFn,
  embedFn?: EmbedFn,
): Promise<number> {
  let generated = 0;

  for (const [communityId, memberIds] of communities) {
    if (memberIds.length === 0) continue;

    // 轻量元数据查询（id + validatedCount）：top-k 签号的输入
    const metaSession = getSession(driver);
    let memberMeta: Array<{ id: string; validatedCount: number }>;
    try {
      const metaResult = await metaSession.run(`
        MATCH (n:Task|Skill|Event {status: 'active'})
        WHERE n.id IN $memberIds
        RETURN n.id AS id, n.validatedCount AS vc
      `, { memberIds });
      memberMeta = metaResult.records.map(r => ({
        id: r.get("id"),
        validatedCount: typeof r.get("vc") === "number" ? r.get("vc") : (r.get("vc")?.toNumber?.() ?? 0),
      }));
    } finally {
      await metaSession.close();
    }
    if (memberMeta.length === 0) continue;

    const memberSignature = buildTopKMemberSignature(memberMeta);

    const current = await getCommunitySummary(driver, communityId);
    if (current?.memberSignature === memberSignature && current.summary.trim()) {
      continue;
    }

    const reusable = await getCommunitySummaryBySignature(driver, memberSignature);
    if (reusable?.summary.trim()) {
      await upsertCommunitySummary(
        driver,
        communityId,
        reusable.summary,
        memberIds.length,
        reusable.embedding,
        memberSignature,
      );
      continue;
    }

    const session = getSession(driver);
    let members: any[];
    try {
      const result = await session.run(`
        MATCH (n:Task|Skill|Event {status: 'active'})
        WHERE n.id IN $memberIds
        RETURN n.name AS name, n.type AS type, n.description AS description
        ORDER BY n.validatedCount DESC
        LIMIT 10
      `, { memberIds });
      members = result.records.map(r => ({
        name: r.get("name"),
        type: r.get("type"),
        description: r.get("description"),
      }));
    } finally {
      await session.close();
    }

    if (members.length === 0) continue;

    const memberText = members
      .map(m => `${m.type}:${m.name} — ${m.description}`)
      .join("\n");

    try {
      const summary = await llm(
        COMMUNITY_SUMMARY_SYS,
        `社区成员：\n${memberText}`,
      );

      const cleaned = stripThinkTags(summary.trim())
        .replace(/^["'「」]|["'「」]$/g, "")
        .replace(/\n/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim()
        .slice(0, 100);

      if (cleaned.length === 0) continue;

      let embedding: number[] | undefined;
      if (embedFn) {
        try {
          const embedText = `${cleaned}\n${members.map(m => m.name).join(", ")}`;
          embedding = await embedFn(embedText, "db");
        } catch {}
      }

      await upsertCommunitySummary(driver, communityId, cleaned, memberIds.length, embedding, memberSignature);
      generated++;
    } catch {
      // 单社区摘要失败静默跳过（与 syncEmbed 的吞错策略一致）——库代码不直接写 stdout
    }
  }

  // prune 必须在复用查找之后：detectCommunities 每轮按成员数重编号 c-1..c-N，
  // 旧 id 社区（summary/memberSignature/embedding 的持有者）在新编号下"无人引用"，
  // 先 prune 会把捐赠者删掉，签名复用永远不生效 → 每轮维护全量重算 LLM 摘要。
  await pruneCommunitySummaries(driver);

  return generated;
}
