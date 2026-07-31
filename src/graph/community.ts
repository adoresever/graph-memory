/**
 * graph-memory-pro — 社区检测 (Neo4j GDS)
 *
 * 替代原版手写的 Label Propagation 算法
 * 使用 GDS gds.labelPropagation
 * 保留 summarizeCommunities()（需要 LLM）
 */

import type { Driver } from "neo4j-driver";
import neo4j from "neo4j-driver";
import { getSession } from "../store/db.ts";
import { updateCommunities, upsertCommunitySummary, pruneCommunitySummaries } from "../store/store.ts";

const ALL_REL_TYPES = ["USED_SKILL", "SOLVED_BY", "REQUIRES", "PATCHES", "CONFLICTS_WITH"];

async function getExistingRelTypes(session: any): Promise<string[]> {
  const result = await session.run(`
    MATCH (:Task|Skill|Event)-[r]->(:Task|Skill|Event)
    WHERE type(r) IN $types
    RETURN DISTINCT type(r) AS t
  `, { types: ALL_REL_TYPES });
  return result.records.map((r: any) => r.get("t"));
}

function buildRelProjection(existingTypes: string[]): string {
  if (existingTypes.length === 0) return "'*'";
  const parts = existingTypes.map(t => `${t}: {orientation: 'UNDIRECTED'}`);
  return `{${parts.join(", ")}}`;
}

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
      return { labels: new Map(), communities: new Map(), count: 0 };
    }

    const existingTypes = await getExistingRelTypes(session);
    if (existingTypes.length === 0) {
      return { labels: new Map(), communities: new Map(), count: 0 };
    }

    const relProjection = buildRelProjection(existingTypes);

    // 标准投影（只包含实际存在的关系类型）
    await session.run(
      `CALL gds.graph.project('${graphName}', ['Task', 'Skill', 'Event'], ${relProjection})`
    );

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

export async function summarizeCommunities(
  driver: Driver,
  communities: Map<string, string[]>,
  llm: CompleteFn,
  embedFn?: EmbedFn,
): Promise<number> {
  await pruneCommunitySummaries(driver);
  let generated = 0;

  for (const [communityId, memberIds] of communities) {
    if (memberIds.length === 0) continue;

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

      const cleaned = summary.trim()
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/<think>[\s\S]*/gi, "")
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
          embedding = await embedFn(embedText);
        } catch {}
      }

      await upsertCommunitySummary(driver, communityId, cleaned, memberIds.length, embedding);
      generated++;
    } catch (err) {
      console.log(`  [WARN] community summary failed for ${communityId}: ${err}`);
    }
  }

  return generated;
}
