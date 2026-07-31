/**
 * graph-memory-pro — 图谱维护
 *
 * 调用时机：session_end（finalize 之后）
 * 执行顺序：去重 → 全局 PageRank → 社区检测 → 社区描述
 */

import type { Driver } from "neo4j-driver";
import type { GmConfig } from "../types.ts";
import type { CompleteFn } from "../engine/llm.ts";
import type { EmbedFn } from "../engine/embed.ts";
import { computeGlobalPageRank, type GlobalPageRankResult } from "./pagerank.ts";
import { detectCommunities, summarizeCommunities, type CommunityResult } from "./community.ts";
import { dedup, type DedupResult } from "./dedup.ts";

export interface MaintenanceResult {
  dedup: DedupResult;
  pagerank: GlobalPageRankResult;
  community: CommunityResult;
  communitySummaries: number;
  durationMs: number;
}

export async function runMaintenance(
  driver: Driver, cfg: GmConfig, llm?: CompleteFn, embedFn?: EmbedFn,
): Promise<MaintenanceResult> {
  const start = Date.now();

  // 1. 去重
  const dedupResult = await dedup(driver, cfg);

  // 2. 全局 PageRank
  const pagerankResult = await computeGlobalPageRank(driver, cfg);

  // 3. 社区检测
  const communityResult = await detectCommunities(driver);

  // 4. 社区描述生成
  let communitySummaries = 0;
  if (llm && communityResult.communities.size > 0) {
    try {
      communitySummaries = await summarizeCommunities(driver, communityResult.communities, llm, embedFn);
    } catch {}
  }

  return {
    dedup: dedupResult,
    pagerank: pagerankResult,
    community: communityResult,
    communitySummaries,
    durationMs: Date.now() - start,
  };
}
