/**
 * graph-memory-pro — 向量去重 (Neo4j 版)
 *
 * 利用 Neo4j 向量索引查找相似节点，替代原版手写余弦相似度
 */

import type { Driver } from "neo4j-driver";
import type { GmConfig } from "../types.ts";
import { getSession } from "../store/db.ts";
import { findById, mergeNodes } from "../store/store.ts";

export interface DuplicatePair {
  nodeA: string;
  nodeB: string;
  nameA: string;
  nameB: string;
  similarity: number;
}

export interface DedupResult {
  pairs: DuplicatePair[];
  merged: number;
}

/**
 * 检测重复节点对 — 用 Neo4j 向量索引
 *
 * 对每个有 embedding 的活跃节点，用它的向量搜索最相似的其他节点
 */
export async function detectDuplicates(driver: Driver, cfg: GmConfig): Promise<DuplicatePair[]> {
  const session = getSession(driver);
  try {
    // 获取所有有 embedding 的活跃节点
    const nodesResult = await session.run(`
      MATCH (n:Task|Skill|Event {status: 'active'})
      WHERE n.embedding IS NOT NULL
      RETURN n.id AS id, n.name AS name, n.embedding AS embedding
    `);

    if (nodesResult.records.length < 2) return [];

    // 逐节点发向量查询是 O(N) 次网络往返，维护链时间随图线性膨胀；
    // 把循环折叠进单条 UNWIND + CALL（服务端逐节点查向量索引，一次往返流式返回）。
    const nodes = nodesResult.records.map(r => ({
      id: r.get("id"),
      name: r.get("name"),
      embedding: r.get("embedding"),
    }));
    const searchResult = await session.run(`
      UNWIND $nodes AS n
      CALL db.index.vector.queryNodes('gm_node_embedding', 5, n.embedding) YIELD node, score
      WHERE node.id <> n.id AND node.status = 'active' AND score >= $threshold
      RETURN n.id AS nodeA, n.name AS nameA, node.id AS nodeB, node.name AS nameB, score AS similarity
    `, { nodes, threshold: cfg.dedupThreshold });

    const pairs: DuplicatePair[] = [];
    const seenPairs = new Set<string>();

    for (const sr of searchResult.records) {
      const nodeId = sr.get("nodeA");
      const otherId = sr.get("nodeB");
      const pairKey = [nodeId, otherId].sort().join("|");
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      pairs.push({
        nodeA: nodeId,
        nodeB: otherId,
        nameA: sr.get("nameA"),
        nameB: sr.get("nameB"),
        similarity: sr.get("similarity"),
      });
    }

    return pairs.sort((a, b) => b.similarity - a.similarity);
  } finally {
    await session.close();
  }
}

/**
 * 检测并自动合并重复节点
 */
export async function dedup(driver: Driver, cfg: GmConfig): Promise<DedupResult> {
  const pairs = await detectDuplicates(driver, cfg);
  let merged = 0;
  const consumed = new Set<string>();

  for (const pair of pairs) {
    if (consumed.has(pair.nodeA) || consumed.has(pair.nodeB)) continue;

    const a = await findById(driver, pair.nodeA);
    const b = await findById(driver, pair.nodeB);
    if (!a || !b) continue;

    // 只合并同类型
    if (a.type !== b.type) continue;

    let keepId: string, mergeId: string;
    if (a.validatedCount > b.validatedCount) {
      keepId = a.id; mergeId = b.id;
    } else if (b.validatedCount > a.validatedCount) {
      keepId = b.id; mergeId = a.id;
    } else {
      keepId = a.updatedAt >= b.updatedAt ? a.id : b.id;
      mergeId = keepId === a.id ? b.id : a.id;
    }

    await mergeNodes(driver, keepId, mergeId);
    consumed.add(mergeId);
    merged++;
  }

  return { pairs, merged };
}
