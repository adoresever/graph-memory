/**
 * graph-memory — 图谱维护
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 *
 * 调用时机：session_end（finalize 之后）
 *
 * 执行顺序：
 *   1. 去重（先合并再算分数，避免重复节点干扰排名）
 *   2. 全局 PageRank（基线分数写入 DB，供 topNodes 兜底用）
 *   3. 社区检测（重新划分知识域）
 *   4. 社区描述生成（LLM 为每个社区生成一句话摘要）
 *
 * 注意：个性化 PPR 不在这里跑，它在 recall 时实时计算。
 */

import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import type { GmConfig } from "../types.ts";
import type { CompleteFn } from "../engine/llm.ts";
import type { EmbedFn } from "../engine/embed.ts";
import { computeGlobalPageRank, invalidateGraphCache, type GlobalPageRankResult } from "./pagerank.ts";
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
  db: DatabaseSyncInstance, cfg: GmConfig, llm?: CompleteFn, embedFn?: EmbedFn,
  summaryMode: "incremental" | "full" = "incremental",
): Promise<MaintenanceResult> {
  const start = Date.now();

  // ─── maintenance 触发计数器 ──────────────────────────────
  try {
    const counterKey = "maintenance_trigger_count";
    const lastTriggerKey = "maintenance_last_trigger_at";
    const row = db.prepare("SELECT value FROM gm_meta WHERE key = ?").get(counterKey) as any;
    const count = row ? parseInt(row.value, 10) + 1 : 1;
    db.prepare("INSERT OR REPLACE INTO gm_meta (key, value) VALUES (?, ?)").run(counterKey, String(count));
    db.prepare("INSERT OR REPLACE INTO gm_meta (key, value) VALUES (?, ?)").run(lastTriggerKey, String(Date.now()));
    if (process.env.GM_DEBUG) {
      console.log(`  [DEBUG] maintenance: trigger #${count} at ${new Date().toISOString()}`);
    }
  } catch (err) {
    if (process.env.GM_DEBUG) {
      console.log(`  [DEBUG] maintenance: counter write failed: ${err}`);
    }
  }

  // 去重/新增节点后清除图结构缓存
  invalidateGraphCache();

  // 1. 去重
  const dedupResult = dedup(db, cfg);

  // 去重可能合并了节点，再清一次缓存
  if (dedupResult.merged > 0) invalidateGraphCache();

  // 2. 全局 PageRank（基线）
  const pagerankResult = computeGlobalPageRank(db, cfg);

  // 3. 社区检测
  const communityResult = detectCommunities(db);

  // 4. 社区描述生成（需要 LLM）
  let communitySummaries = 0;
  if (llm && communityResult.communities.size > 0) {
    try {
      communitySummaries = await summarizeCommunities(
        db, communityResult.communities, llm, embedFn, summaryMode, cfg.communitySummaryMaxTokens,
      );
      if (process.env.GM_DEBUG) {
        console.log(`  [DEBUG] maintenance: generated ${communitySummaries} community summaries`);
      }
    } catch (err) {
      if (process.env.GM_DEBUG) {
        console.log(`  [DEBUG] maintenance: community summarization failed: ${err}`);
      }
    }
  }

  const durationMs = Date.now() - start;

  // ─── 记录本次 maintenance 结果 ──────────────────────────
  try {
    const resultKey = "maintenance_last_result";
    const result = {
      at: new Date().toISOString(),
      durationMs,
      dedupMerged: dedupResult.merged,
      communityCount: communityResult.communities.size,
      communitySummaries,
      summaryMode,
    };
    db.prepare("INSERT OR REPLACE INTO gm_meta (key, value) VALUES (?, ?)").run(resultKey, JSON.stringify(result));
    if (process.env.GM_DEBUG) {
      console.log(`  [DEBUG] maintenance: completed in ${durationMs}ms, ${communitySummaries} summaries`);
    }
  } catch (err) {
    if (process.env.GM_DEBUG) {
      console.log(`  [DEBUG] maintenance: result write failed: ${err}`);
    }
  }

  return {
    dedup: dedupResult,
    pagerank: pagerankResult,
    community: communityResult,
    communitySummaries,
    durationMs,
  };
}
