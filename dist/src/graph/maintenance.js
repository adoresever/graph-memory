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
import { computeGlobalPageRank, invalidateGraphCache } from "./pagerank.js";
import { detectCommunities, summarizeCommunities } from "./community.js";
import { dedup } from "./dedup.js";
export async function runMaintenance(db, cfg, llm, embedFn) {
    const start = Date.now();
    // 去重/新增节点后清除图结构缓存
    invalidateGraphCache();
    // 1. 去重
    const dedupResult = dedup(db, cfg);
    // 去重可能合并了节点，再清一次缓存
    if (dedupResult.merged > 0)
        invalidateGraphCache();
    // 2. 全局 PageRank（基线）
    const pagerankResult = computeGlobalPageRank(db, cfg);
    // 3. 社区检测
    const communityResult = detectCommunities(db);
    // 4. 社区描述生成（需要 LLM）
    let communitySummaries = 0;
    if (llm && communityResult.communities.size > 0) {
        try {
            communitySummaries = await summarizeCommunities(db, communityResult.communities, llm, embedFn);
        }
        catch { /* summaries are best-effort and must not fail maintenance */ }
    }
    return {
        dedup: dedupResult,
        pagerank: pagerankResult,
        community: communityResult,
        communitySummaries,
        durationMs: Date.now() - start,
    };
}
