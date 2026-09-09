/**
 * graph-memory — 图谱维护
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 *
 * 调用时机：session_end
 *
 * 执行顺序：
 *   1. 全局 PageRank（基线分数写入 DB，供 topNodes 兜底用）
 *   2. 社区检测（重新划分知识域）
 *
 * 注意：个性化 PPR 不在这里跑，它在 recall 时实时计算。
 */

import { DatabaseSync, type DatabaseSyncInstance } from "../store/sqlite.ts";
import type { GmConfig } from "../types.ts";
import { computeGlobalPageRank, invalidateGraphCache, type GlobalPageRankResult } from "./pagerank.ts";
import { detectCommunities, detectNavigationCommunities, type CommunityResult } from "./community.ts";

export interface MaintenanceResult {
  pagerank: GlobalPageRankResult;
  community: CommunityResult;
  navigationCommunity: CommunityResult;
  durationMs: number;
}

export async function runMaintenance(db: DatabaseSyncInstance, cfg: GmConfig): Promise<MaintenanceResult> {
  const start = Date.now();

  // New graph writes require a fresh ranking/cache view.
  invalidateGraphCache(db);

  // 1. 全局 PageRank（基线）
  const pagerankResult = computeGlobalPageRank(db, cfg);

  // 2. 社区检测
  const communityResult = detectCommunities(db);
  const navigationCommunityResult = detectNavigationCommunities(db);

  return {
    pagerank: pagerankResult,
    community: communityResult,
    navigationCommunity: navigationCommunityResult,
    durationMs: Date.now() - start,
  };
}
