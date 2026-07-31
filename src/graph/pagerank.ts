/**
 * graph-memory-pro — PageRank (Neo4j GDS 2.12 OpenGDS)
 *
 * 关键：GDS gds.graph.project 要求投影的关系类型必须在数据库中存在
 * 所以先查有哪些关系类型，只投影存在的
 */

import type { Driver, Session } from "neo4j-driver";
import type { GmConfig } from "../types.ts";
import { getSession } from "../store/db.ts";

const ALL_REL_TYPES = ["USED_SKILL", "SOLVED_BY", "REQUIRES", "PATCHES", "CONFLICTS_WITH"];

/**
 * 查询数据库中实际存在的知识节点关系类型
 */
async function getExistingRelTypes(session: Session): Promise<string[]> {
  const result = await session.run(`
    MATCH (:Task|Skill|Event)-[r]->(:Task|Skill|Event)
    WHERE type(r) IN $types
    RETURN DISTINCT type(r) AS t
  `, { types: ALL_REL_TYPES });
  return result.records.map(r => r.get("t"));
}

/**
 * 构建 GDS 投影的关系类型 map（只包含存在的）
 */
function buildRelProjection(existingTypes: string[]): string {
  if (existingTypes.length === 0) return "'*'";
  const parts = existingTypes.map(t => `${t}: {orientation: 'UNDIRECTED'}`);
  return `{${parts.join(", ")}}`;
}

// ─── 个性化 PageRank ─────────────────────────────────────────

export interface PPRResult {
  scores: Map<string, number>;
}

export async function personalizedPageRank(
  driver: Driver,
  seedIds: string[],
  candidateIds: string[],
  cfg: GmConfig,
): Promise<PPRResult> {
  if (!seedIds.length || !candidateIds.length) {
    return { scores: new Map() };
  }

  const session = getSession(driver);
  try {
    const existingTypes = await getExistingRelTypes(session);
    if (existingTypes.length === 0) {
      // 没有关系，fallback
      const scores = new Map<string, number>();
      candidateIds.forEach((id, i) => scores.set(id, 1 / (i + 1)));
      return { scores };
    }

    const graphName = `gm-ppr-${Date.now()}`;
    const relProjection = buildRelProjection(existingTypes);

    try {
      await session.run(
        `CALL gds.graph.project('${graphName}', ['Task', 'Skill', 'Event'], ${relProjection})`
      );

      const seedResult = await session.run(`
        MATCH (n:Task|Skill|Event) WHERE n.id IN $seedIds AND n.status = 'active'
        RETURN id(n) AS neoId
      `, { seedIds });
      const sourceNodeIds = seedResult.records.map(r => r.get("neoId"));

      if (sourceNodeIds.length === 0) {
        await session.run(`CALL gds.graph.drop('${graphName}')`);
        return { scores: new Map() };
      }

      const pprResult = await session.run(`
        CALL gds.pageRank.stream('${graphName}', {
          dampingFactor: $damping,
          maxIterations: toInteger($iterations),
          sourceNodes: $sourceNodes
        })
        YIELD nodeId, score
        WITH gds.util.asNode(nodeId) AS node, score
        WHERE node.id IN $candidateIds AND node.status = 'active'
        RETURN node.id AS id, score
        ORDER BY score DESC
      `, {
        damping: cfg.pagerankDamping,
        iterations: cfg.pagerankIterations,
        sourceNodes: sourceNodeIds,
        candidateIds,
      });

      const scores = new Map<string, number>();
      for (const r of pprResult.records) {
        scores.set(r.get("id"), typeof r.get("score") === "number" ? r.get("score") : 0);
      }

      await session.run(`CALL gds.graph.drop('${graphName}')`);
      return { scores };
    } catch {
      try { await session.run(`CALL gds.graph.drop('${graphName}')`); } catch {}
      const scores = new Map<string, number>();
      candidateIds.forEach((id, i) => scores.set(id, 1 / (i + 1)));
      return { scores };
    }
  } finally {
    await session.close();
  }
}

// ─── 全局 PageRank ──────────────────────────────────────────

export interface GlobalPageRankResult {
  scores: Map<string, number>;
  topK: Array<{ id: string; name: string; score: number }>;
}

export async function computeGlobalPageRank(driver: Driver, cfg: GmConfig): Promise<GlobalPageRankResult> {
  const session = getSession(driver);
  const graphName = `gm-global-pr-${Date.now()}`;

  try {
    const countResult = await session.run("MATCH (n:Task|Skill|Event {status: 'active'}) RETURN count(n) AS c");
    const nodeCount = countResult.records[0]?.get("c")?.toNumber?.() ?? 0;
    if (nodeCount === 0) return { scores: new Map(), topK: [] };

    const existingTypes = await getExistingRelTypes(session);
    if (existingTypes.length === 0) {
      // 没有关系，均匀分
      const uniformScore = 1 / nodeCount;
      await session.run("MATCH (n:Task|Skill|Event {status: 'active'}) SET n.pagerank = $score", { score: uniformScore });
      const topResult = await session.run(`
        MATCH (n:Task|Skill|Event {status: 'active'}) RETURN n.id AS id, n.name AS name, n.pagerank AS score
        ORDER BY n.pagerank DESC LIMIT 20
      `);
      const scores = new Map<string, number>();
      const topK = topResult.records.map(r => {
        scores.set(r.get("id"), uniformScore);
        return { id: r.get("id"), name: r.get("name"), score: uniformScore };
      });
      return { scores, topK };
    }

    const relProjection = buildRelProjection(existingTypes);
    await session.run(
      `CALL gds.graph.project('${graphName}', ['Task', 'Skill', 'Event'], ${relProjection})`
    );

    await session.run(`
      CALL gds.pageRank.write('${graphName}', {
        writeProperty: 'pagerank',
        dampingFactor: $damping,
        maxIterations: toInteger($iterations)
      })
    `, { damping: cfg.pagerankDamping, iterations: cfg.pagerankIterations });

    await session.run(`CALL gds.graph.drop('${graphName}')`);

    const topResult = await session.run(`
      MATCH (n:Task|Skill|Event {status: 'active'}) RETURN n.id AS id, n.name AS name, n.pagerank AS score
      ORDER BY n.pagerank DESC LIMIT 20
    `);

    const scores = new Map<string, number>();
    const topK: Array<{ id: string; name: string; score: number }> = [];
    for (const r of topResult.records) {
      const rawScore = r.get("score");
      const score = typeof rawScore === "number" ? rawScore : (rawScore?.toNumber?.() ?? 0);
      scores.set(r.get("id"), score);
      topK.push({ id: r.get("id"), name: r.get("name"), score });
    }
    return { scores, topK };
  } catch {
    try { await session.run(`CALL gds.graph.drop('${graphName}')`); } catch {}
    return { scores: new Map(), topK: [] };
  } finally {
    await session.close();
  }
}
