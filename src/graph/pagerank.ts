/**
 * graph-memory — Personalized PageRank (PPR)
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 *
 * ═══════════════════════════════════════════════════════════════
 * 个性化 PageRank（Personalized PageRank）
 *
 * 区别于全局 PageRank：
 *   全局 PR：所有节点均匀起步，算一个固定的全局排名
 *   个性化 PPR：从用户查询命中的种子节点出发，沿边传播权重
 *              离种子越近的节点分数越高
 *
 * 同一个图谱：
 *   问 "Docker 部署"   → Docker 相关 SKILL 分数最高
 *   问 "conda 环境"    → conda 相关 SKILL 分数最高
 *   问 "bilibili 爬虫" → bilibili 相关 TASK/SKILL 分数最高
 *
 * 计算时机：
 *   recall 时实时算（不存数据库），每次查询都是新鲜的
 *   O(iterations * edges)，几千节点 < 5ms
 *
 * 另外保留一个全局 PageRank 作为基线，用于：
 *   - topNodes 兜底（没有种子时）
 *   - session_end 时写入 gm_nodes.pagerank 列
 * ═══════════════════════════════════════════════════════════════
 */

import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import type { GmConfig } from "../types.ts";
import { updatePageranks } from "../store/store.ts";

// ─── 图结构缓存（避免每次 recall 都查 SQL） ─────────────────

interface GraphStructure {
  nodeIds: Set<string>;
  /** 无向邻接表 */
  adj: Map<string, string[]>;
  /** 节点数 */
  N: number;
  /** 缓存时间 */
  cachedAt: number;
}

const _cachedGraphs = new WeakMap<DatabaseSyncInstance, GraphStructure>();
const CACHE_TTL = 30_000; // 30 秒缓存

/**
 * 读取图结构（带缓存，按 db 实例隔离）
 * compact 会新增节点/边，但 30 秒内的查询共享同一份图结构没问题
 */
function loadGraph(db: DatabaseSyncInstance): GraphStructure {
  const existing = _cachedGraphs.get(db);
  if (existing && Date.now() - existing.cachedAt < CACHE_TTL) return existing;

  const nodeRows = db.prepare(
    "SELECT id FROM gm_nodes WHERE status='active'"
  ).all() as any[];
  const nodeIds = new Set(nodeRows.map((r: any) => r.id));

  const edgeRows = db.prepare("SELECT from_id, to_id FROM gm_edges").all() as any[];
  const adj = new Map<string, string[]>();

  for (const id of nodeIds) adj.set(id, []);

  for (const e of edgeRows) {
    if (!nodeIds.has(e.from_id) || !nodeIds.has(e.to_id)) continue;
    adj.get(e.from_id)!.push(e.to_id);
    adj.get(e.to_id)!.push(e.from_id);
  }

  const fresh = { nodeIds, adj, N: nodeIds.size, cachedAt: Date.now() };
  _cachedGraphs.set(db, fresh);
  return fresh;
}

/** 图结构变化时清除对应 db 的缓存（compact/finalize 后调用） */
export function invalidateGraphCache(db: DatabaseSyncInstance): void {
  _cachedGraphs.delete(db);
}

// ─── 个性化 PageRank ─────────────────────────────────────────

export interface PPRResult {
  /** nodeId → 个性化分数 */
  scores: Map<string, number>;
}

/**
 * 个性化 PageRank
 *
 * 从 seedIds 出发传播权重：
 *   - teleport 概率 (1-damping) 总是回到种子节点（不是均匀回到所有节点）
 *   - 这样种子附近的节点天然获得更高分数
 *
 * @param seedIds  用户查询命中的种子节点（FTS5/向量搜索结果）
 * @param candidateIds  需要排序的候选节点（图遍历结果）
 * @returns 候选节点的个性化分数
 */
export function personalizedPageRank(
  db: DatabaseSyncInstance,
  seedIds: string[],
  candidateIds: string[],
  cfg: GmConfig,
): PPRResult {
  const graph = loadGraph(db);
  const { nodeIds, adj, N } = graph;
  const damping = cfg.pagerankDamping;
  const iterations = cfg.pagerankIterations;

  if (N === 0 || seedIds.length === 0) {
    return { scores: new Map() };
  }

  // 种子节点集合（过滤掉不存在的）
  const validSeeds = seedIds.filter(id => nodeIds.has(id));
  if (validSeeds.length === 0) return { scores: new Map() };

  // teleport 向量：只指向种子节点，均匀分配
  const teleportWeight = 1 / validSeeds.length;
  const seedSet = new Set(validSeeds);

  // 初始分数：集中在种子节点上
  let rank = new Map<string, number>();
  for (const id of nodeIds) {
    rank.set(id, seedSet.has(id) ? teleportWeight : 0);
  }

  // 迭代
  for (let i = 0; i < iterations; i++) {
    const newRank = new Map<string, number>();

    // teleport 分量：回到种子节点
    for (const id of nodeIds) {
      newRank.set(id, seedSet.has(id) ? (1 - damping) * teleportWeight : 0);
    }

    // 传播分量：从邻居获得权重
    for (const [nodeId, neighbors] of adj) {
      if (neighbors.length === 0) continue;
      const contrib = (rank.get(nodeId) || 0) / neighbors.length;
      if (contrib === 0) continue;
      for (const nb of neighbors) {
        newRank.set(nb, (newRank.get(nb) || 0) + damping * contrib);
      }
    }

    // dangling nodes 的分数传播回种子节点（不是均匀分配到所有节点）
    let danglingSum = 0;
    for (const id of nodeIds) {
      const neighbors = adj.get(id);
      if (!neighbors || neighbors.length === 0) {
        danglingSum += rank.get(id) || 0;
      }
    }
    if (danglingSum > 0) {
      const danglingContrib = damping * danglingSum * teleportWeight;
      for (const sid of validSeeds) {
        newRank.set(sid, (newRank.get(sid) || 0) + danglingContrib);
      }
    }

    rank = newRank;
  }

  // 只返回候选节点的分数
  const result = new Map<string, number>();
  for (const id of candidateIds) {
    result.set(id, rank.get(id) || 0);
  }

  return { scores: result };
}

// ─── 全局 PageRank（基线，session_end 时更新） ──────────────

export interface GlobalPageRankResult {
  scores: Map<string, number>;
  topK: Array<{ id: string; name: string; score: number }>;
}

/**
 * 全局 PageRank — 写入 gm_nodes.pagerank 作为基线
 *
 * 用途：
 *   - topNodes 兜底排序（没有查询种子时的 fallback）
 *   - gm_stats 展示全局重要节点
 *
 * 只在 session_end / gm_maintain 时调用
 */
export function computeGlobalPageRank(db: DatabaseSyncInstance, cfg: GmConfig): GlobalPageRankResult {
  const graph = loadGraph(db);
  const { nodeIds, adj, N } = graph;
  const damping = cfg.pagerankDamping;
  const iterations = cfg.pagerankIterations;

  if (N === 0) return { scores: new Map(), topK: [] };

  const nameRows = db.prepare(
    "SELECT id, name FROM gm_nodes WHERE status='active'"
  ).all() as any[];
  const nameMap = new Map<string, string>();
  nameRows.forEach(r => nameMap.set(r.id, r.name));

  // 全局：均匀 teleport
  let rank = new Map<string, number>();
  const init = 1 / N;
  for (const id of nodeIds) rank.set(id, init);

  for (let i = 0; i < iterations; i++) {
    const newRank = new Map<string, number>();
    const base = (1 - damping) / N;
    for (const id of nodeIds) newRank.set(id, base);

    for (const [nodeId, neighbors] of adj) {
      if (neighbors.length === 0) continue;
      const contrib = (rank.get(nodeId) || 0) / neighbors.length;
      for (const nb of neighbors) {
        newRank.set(nb, (newRank.get(nb) || base) + damping * contrib);
      }
    }

    let danglingSum = 0;
    for (const id of nodeIds) {
      const neighbors = adj.get(id);
      if (!neighbors || neighbors.length === 0) danglingSum += rank.get(id) || 0;
    }
    if (danglingSum > 0) {
      const dc = damping * danglingSum / N;
      for (const id of nodeIds) newRank.set(id, (newRank.get(id) || 0) + dc);
    }

    rank = newRank;
  }

  // 写入数据库
  updatePageranks(db, rank);

  const sorted = Array.from(rank.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([id, score]) => ({ id, name: nameMap.get(id) || id, score }));

  return { scores: rank, topK: sorted };
}