/**
 * graph-memory-pro — PageRank (Neo4j GDS 2.12 OpenGDS)
 *
 * 关键：GDS gds.graph.project 要求投影的关系类型必须在数据库中存在
 * 所以先查有哪些关系类型，只投影存在的
 */

import type { Driver, Session } from "neo4j-driver";
import type { GmConfig } from "../types.ts";
import { getSession } from "../store/db.ts";
import { getExistingActiveRelTypes, projectActiveGraph } from "./projection.ts";

/**
 * 读回 pagerank top-20 并构建 scores Map + topK 数组 —— global PR 的三条路径
 * （均匀分兜底 / GDS write 后读回 / 无 GDS fallback）共用的收尾读取。
 * tiebreakCreatedAt=true 时以 createdAt ASC 决胜（fallback 路径的稳定序）。
 */
async function readTopKByPagerank(session: Session, tiebreakCreatedAt = false): Promise<{
  scores: Map<string, number>;
  topK: Array<{ id: string; name: string; score: number }>;
}> {
  const topResult = await session.run(`
    MATCH (n:Task|Skill|Event {status: 'active'})
    RETURN n.id AS id, n.name AS name, n.pagerank AS score
    ORDER BY n.pagerank DESC ${tiebreakCreatedAt ? ", n.createdAt ASC" : ""}
    LIMIT 20
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
    const existingTypes = await getExistingActiveRelTypes(session);
    if (existingTypes.length === 0) {
      // 没有关系，fallback
      const scores = new Map<string, number>();
      candidateIds.forEach((id, i) => scores.set(id, 1 / (i + 1)));
      return { scores };
    }

    const graphName = `gm-ppr-${Date.now()}`;
    try {
      await projectActiveGraph(session, graphName, existingTypes);

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

    const existingTypes = await getExistingActiveRelTypes(session);
    if (existingTypes.length === 0) {
      // 没有关系，均匀分
      const uniformScore = 1 / nodeCount;
      await session.run("MATCH (n:Task|Skill|Event {status: 'active'}) SET n.pagerank = $score", { score: uniformScore });
      return await readTopKByPagerank(session);
    }

    await projectActiveGraph(session, graphName, existingTypes);

    try {
      await session.run(`
        CALL gds.pageRank.write('${graphName}', {
          writeProperty: 'pagerank',
          dampingFactor: $damping,
          maxIterations: toInteger($iterations)
        })
      `, { damping: cfg.pagerankDamping, iterations: cfg.pagerankIterations });
    } finally {
      // drop 失败只能吞掉（宁泄漏一个临时投影）：此分支若抛错落入外层 catch，
      // fallback 会用 1/(i+1) 覆盖刚 write 成功的真实 PageRank —— 数据损坏远重于投影泄漏
      try { await session.run(`CALL gds.graph.drop('${graphName}')`); } catch {}
    }

    // write 已成功：pagerank 属性已是真值，后续读取失败只返回空排序，
    // 绝不回落外层 catch 的 fallback（那会覆盖全图正确分数）
    try {
      return await readTopKByPagerank(session);
    } catch {
      return { scores: new Map(), topK: [] };
    }
  } catch {
    try { await session.run(`CALL gds.graph.drop('${graphName}')`); } catch {}
    // GDS 不可用时降级为确定性 fallback（与 PPR 一致：按稳定排序赋 1/(i+1)）
    await session.run(`
      MATCH (n:Task|Skill|Event {status: 'active'})
      WITH n ORDER BY n.createdAt ASC, n.id ASC
      WITH collect(n) AS nodes
      UNWIND range(0, size(nodes) - 1) AS idx
      WITH nodes[idx] AS node, idx
      SET node.pagerank = 1.0 / toFloat(idx + 1)
    `);
    return await readTopKByPagerank(session, true);
  } finally {
    await session.close();
  }
}
