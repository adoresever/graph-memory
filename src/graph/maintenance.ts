/**
 * graph-memory-pro — 图谱维护
 *
 * 调用时机：session_end（finalize 之后）
 * 执行顺序：衰减（含自动弃用）→ 过期清理（硬删）→ 去重 → 全局 PageRank → 社区检测 → 社区描述 → 消息保留（opt-in）
 */

import type { Driver } from "neo4j-driver";
import type { GmConfig } from "../types.ts";
import type { CompleteFn } from "../engine/llm.ts";
import type { EmbedFn } from "../engine/embed.ts";
import { computeGlobalPageRank, type GlobalPageRankResult } from "./pagerank.ts";
import { detectCommunities, summarizeCommunities, type CommunityResult } from "./community.ts";
import { dedup, type DedupResult } from "./dedup.ts";
import { applyDecay, type DecayResult } from "./decay.ts";
import { purgeDeprecatedNodes } from "../store/store.ts";
import {
  normalizeMessageRetentionPolicy, runMessageRetention,
  type MessageRetentionResult,
} from "../store/retention.ts";

export interface MaintenanceResult {
  decay: DecayResult;
  /** 两阶段生命周期·阶段二：本次硬删的过期 deprecated 节点数（purgeAfterDays=0 时恒 0）。 */
  purged: number;
  /** 硬删步骤失败时的错误（fail-soft，不否定整轮维护；下一周期重试）。 */
  purgeError?: string;
  dedup: DedupResult;
  pagerank: GlobalPageRankResult;
  community: CommunityResult;
  communitySummaries: number;
  /** 原始消息保留（opt-in）；未配置 messageRetention 或 keep=all 时为 undefined，
   *  执行失败时为 { error }（fail-soft，不否定整轮维护）。 */
  retention?: MessageRetentionResult | { error: string };
  durationMs: number;
}

export async function runMaintenance(
  driver: Driver, cfg: GmConfig, llm?: CompleteFn, embedFn?: EmbedFn,
): Promise<MaintenanceResult> {
  const start = Date.now();

  // 0. 衰减（柔性评分 + tier 转换 + 遗忘曲线自动弃用）—— 先于其他步骤，让后续基于最新 tier 集合运算
  const decayResult = await applyDecay(driver, cfg);

  // 0.5 过期 deprecated 节点硬删（两阶段生命周期·阶段二，释放存储）。
  // 独立于 decay.enabled：手动弃用/merge 的节点同样到期清理，只看 purgeAfterDays。
  // fail-soft：错误记入结果由调用方记日志，不否定已完成的 decay 及后续步骤。
  let purged = 0;
  let purgeError: string | undefined;
  try {
    purged = await purgeDeprecatedNodes(driver, (cfg.decay?.purgeAfterDays ?? 0) * 86_400_000, start);
  } catch (err) {
    purgeError = String(err);
  }

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

  // 5. 原始消息保留（opt-in；keep=all 零开销直返）。
  // fail-soft：链尾清理失败（非法策略 fail-closed 不删 / Neo4j 故障）不应否定
  // 已完成的 decay/dedup/PageRank/社区步骤 —— 前面步骤成功说明连接健康，
  // 也不计入 Neo4j 熔断。错误记入结果，由调用方记日志，下一周期重试。
  let retention: MessageRetentionResult | { error: string } | undefined;
  if (cfg.messageRetention) {
    try {
      const policy = normalizeMessageRetentionPolicy(cfg.messageRetention);
      if (policy.keep !== "all") {
        retention = await runMessageRetention(driver, policy);
      }
    } catch (err) {
      retention = { error: String(err) };
    }
  }

  return {
    decay: decayResult,
    purged,
    ...(purgeError ? { purgeError } : {}),
    dedup: dedupResult,
    pagerank: pagerankResult,
    community: communityResult,
    communitySummaries,
    ...(retention ? { retention } : {}),
    durationMs: Date.now() - start,
  };
}
