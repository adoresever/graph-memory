/**
 * graph-memory-pro CLI — `openclaw graph-memory reembed`
 *
 * 换 embedding 模型后的一次性重建管线。旧模型的向量与新模型不可比（维度甚至
 * 不同），而向量只写不删 —— recall/dedup 的 `WHERE embedding IS NOT NULL` 防御
 * 会让旧向量静默失效（dedup 维度不符时整个向量查询直接报错）。流程：
 *   1. 探测当前模型输出维度，对照 gm_node_embedding / gm_community_embedding 索引维度
 *      （不符时默认中止；--recreate-index 删除索引并按配置重建）
 *   2. 清空（void）所有 MemoryNode.embedding + contentHash、Community.embedding
 *   3. 用当前 embedding 模型按批重建（标准端点走批量 input[]；批失败退化为逐条）
 *      文本格式复用 buildNodeEmbeddingText，hash 语义与运行时 syncEmbed 一致。
 *
 * 命令在 cli-metadata 模式下运行（register() 早早 return），所以这里自行完成
 * Neo4j driver / schema / embedder 的初始化，并在 finally 中 closeDriver。
 */

import type { Driver } from "neo4j-driver";
import type { GmConfig } from "./types.ts";
import { getDriver, initSchema, closeDriver } from "./store/db.ts";
import {
  getEmbeddingStats,
  clearAllEmbeddings,
  listNodeEmbeddingTargets,
  listCommunityEmbeddingTargets,
  saveVector,
  saveCommunityEmbedding,
  getVectorIndexDimensions,
  dropVectorIndexes,
} from "./store/store.ts";
import { createEmbedder, type Embedder } from "./engine/embed.ts";
import { buildNodeEmbeddingText } from "./recaller/recall.ts";
import { isAffirmative } from "./cli-extract.ts";
import { defaultLog, makeDefaultPrompt } from "./cli-io.ts";

export const DEFAULT_REEMBED_BATCH = 32;
const MAX_REEMBED_BATCH = 256;

export interface ReembedOptions {
  yes?: boolean;
  dryRun?: boolean;
  batch?: number;
  recreateIndex?: boolean;
}

export interface ReembedParams {
  cfg: GmConfig;
  options: ReembedOptions;
  log?: (msg: string) => void;
  prompt?: (question: string) => Promise<string>;
}

export interface ReembedResult {
  clearedNodes: number;
  clearedCommunities: number;
  nodesEmbedded: number;
  nodesFailed: number;
  communitiesEmbedded: number;
  communitiesFailed: number;
  batches: number;
  recreatedIndex: boolean;
  durationMs: number;
}

// ─── 维度决策（纯函数，可测） ─────────────────────────────────

export type ReembedPlan =
  | { action: "run" }
  | { action: "recreate-index"; reason: string }
  | { action: "abort"; reason: string };

/**
 * 对照"当前模型输出维度"与"两个向量索引的实际维度"决定行动。
 * 索引不存在（全新库 / 索引被删）→ run：initSchema 已按当前配置重建。
 */
export function planReembed(params: {
  probeDim: number;
  nodeIndexDim: number | null;
  communityIndexDim: number | null;
  recreateIndex?: boolean;
}): ReembedPlan {
  const { probeDim, nodeIndexDim, communityIndexDim, recreateIndex } = params;
  const dims = [...new Set([nodeIndexDim, communityIndexDim].filter(
    (d): d is number => typeof d === "number",
  ))];
  if (!dims.length) return { action: "run" };
  if (!dims.some(d => d !== probeDim)) return { action: "run" };

  const dimText = dims.join("/");
  if (recreateIndex) {
    return {
      action: "recreate-index",
      reason: `向量索引维度（${dimText}）与当前模型输出（${probeDim}）不符，将删除索引并按配置重建`,
    };
  }
  return {
    action: "abort",
    reason:
      `向量索引维度（${dimText}）与当前 embedding 模型输出维度（${probeDim}）不一致。` +
      `换模型后必须重建索引：加 --recreate-index 让本命令删除并按新维度重建（旧向量会一并作废），` +
      `或把 embedding.dimensions 改回 ${dimText}。`,
  };
}

function clampBatch(batch: number | undefined): number {
  if (!batch || !Number.isFinite(batch) || batch < 1) return DEFAULT_REEMBED_BATCH;
  return Math.min(Math.floor(batch), MAX_REEMBED_BATCH);
}

/** 单批嵌入：优先批量调用，失败退化为逐条请求（兼容批量响应结构未知的 provider） */
async function embedTexts(
  embedder: Embedder,
  texts: string[],
  log: (msg: string) => void,
): Promise<{ vecs: (number[] | null)[]; batchCalls: number }> {
  try {
    const vecs = await embedder.embedBatch(texts, "db");
    return { vecs, batchCalls: 1 };
  } catch (err) {
    if (texts.length === 1) throw err;
    log(`  批量调用失败（${err instanceof Error ? err.message : String(err)}），本批退化为逐条请求`);
  }
  const vecs: (number[] | null)[] = [];
  for (const text of texts) {
    try {
      vecs.push(await embedder.embed(text, "db"));
    } catch {
      vecs.push(null);
    }
  }
  return { vecs, batchCalls: texts.length };
}

export async function runReembed(params: ReembedParams): Promise<ReembedResult> {
  const start = Date.now();
  const log = params.log ?? defaultLog;
  const opts = params.options;
  const cfg = params.cfg;
  const batch = clampBatch(opts.batch);

  const result: ReembedResult = {
    clearedNodes: 0,
    clearedCommunities: 0,
    nodesEmbedded: 0,
    nodesFailed: 0,
    communitiesEmbedded: 0,
    communitiesFailed: 0,
    batches: 0,
    recreatedIndex: false,
    durationMs: 0,
  };

  if (!cfg.neo4j?.uri) {
    throw new Error(
      "[graph-memory-pro] reembed 需要 neo4j.uri 配置。请在 graph-memory-pro 插件配置中设置 neo4j.uri / neo4j.user / neo4j.password。",
    );
  }
  if (!cfg.embedding || (!cfg.embedding.apiKey && !cfg.embedding.baseURL)) {
    throw new Error(
      "[graph-memory-pro] reembed 需要 embedding 配置（embedding.apiKey 或 embedding.baseURL）。" +
      "请先在插件配置中指向新的 embedding 模型。",
    );
  }

  const driver: Driver = getDriver(cfg.neo4j);

  try {
    log("[graph-memory-pro] 正在初始化 Neo4j schema...");
    await initSchema(driver, cfg.embedding);

    log("[graph-memory-pro] 正在探测 embedding 端点...");
    const embedder = await createEmbedder(cfg.embedding);
    if (!embedder) {
      throw new Error("[graph-memory-pro] embedding 端点探测失败，无法重嵌入。请检查 embedding.apiKey / baseURL / model。");
    }
    const probeDim = (await embedder.embed("ping", "query")).length;

    // ── 维度对照 ──
    const indexDims = await getVectorIndexDimensions(driver);
    const plan = planReembed({
      probeDim,
      nodeIndexDim: indexDims.gm_node_embedding,
      communityIndexDim: indexDims.gm_community_embedding,
      recreateIndex: opts.recreateIndex,
    });

    const stats = await getEmbeddingStats(driver);
    log(`\n[graph-memory-pro] 当前模型输出维度: ${probeDim}`);
    log(`[graph-memory-pro] 向量索引维度: node=${indexDims.gm_node_embedding ?? "(未建)"} community=${indexDims.gm_community_embedding ?? "(未建)"}`);
    log(`[graph-memory-pro] 活跃节点: ${stats.nodesTotal}（已有向量 ${stats.nodesEmbedded}，待重建 ${stats.nodesTotal - stats.nodesEmbedded}）`);
    log(`[graph-memory-pro] 社区: ${stats.communitiesTotal}（已有向量 ${stats.communitiesEmbedded}）`);

    if (plan.action === "abort") {
      throw new Error(`[graph-memory-pro] ${plan.reason}`);
    }
    if (plan.action === "recreate-index") {
      log(`[graph-memory-pro] ${plan.reason}`);
      if (opts.dryRun) {
        log("[graph-memory-pro] --dry-run 模式，未执行任何更改。");
        result.durationMs = Date.now() - start;
        return result;
      }
      await dropVectorIndexes(driver);
      await initSchema(driver, cfg.embedding);
      result.recreatedIndex = true;
      log("[graph-memory-pro] 向量索引已按当前配置重建。");
    }

    if (opts.dryRun) {
      const pending = stats.nodesTotal - stats.nodesEmbedded + stats.communitiesTotal - stats.communitiesEmbedded;
      log(`\n[graph-memory-pro] --dry-run：将清除全部现有向量并按每批 ${batch} 条重建约 ${pending} 条 embedding，未执行任何更改。`);
      result.durationMs = Date.now() - start;
      return result;
    }

    if (!opts.yes) {
      const prompt = params.prompt ?? makeDefaultPrompt("GRAPH_MEMORY_REEMBED_CONFIRM");
      const answer = await prompt(
        `\n将清除现有节点/社区向量并用当前模型重建（每批 ${batch} 条），继续？[y/N] `,
      );
      if (!isAffirmative(answer)) {
        log("[graph-memory-pro] 已取消。");
        result.durationMs = Date.now() - start;
        return result;
      }
    }

    // ── 清空旧向量 ──
    const cleared = await clearAllEmbeddings(driver);
    result.clearedNodes = cleared.nodes;
    result.clearedCommunities = cleared.communities;
    log(`\n[graph-memory-pro] 已清除 ${cleared.nodes} 个节点 / ${cleared.communities} 个社区的旧向量。`);

    // ── 节点重建（游标分页：重建会让 NULL 集合收缩，SKIP 分页会跳号） ──
    log(`[graph-memory-pro] 开始重建节点向量（每批 ${batch} 条）...`);
    let nodeCursor = "";
    for (;;) {
      const targets = await listNodeEmbeddingTargets(driver, nodeCursor, batch);
      if (!targets.length) break;
      nodeCursor = targets[targets.length - 1].id;

      const texts = targets.map(t => buildNodeEmbeddingText(t));
      const embeddable = targets
        .map((t, i) => ({ t, text: texts[i] }))
        .filter(x => x.text.trim().length > 0);

      if (embeddable.length < targets.length) {
        const skipped = targets.length - embeddable.length;
        result.nodesFailed += skipped;
        log(`  跳过 ${skipped} 个文本为空的节点（保持无向量，不影响文本搜索）`);
      }

      if (embeddable.length) {
        const { vecs, batchCalls } = await embedTexts(
          embedder,
          embeddable.map(x => x.text),
          log,
        );
        result.batches += batchCalls;
        for (let i = 0; i < embeddable.length; i++) {
          const vec = vecs[i];
          if (!vec) {
            result.nodesFailed += 1;
            continue;
          }
          await saveVector(driver, embeddable[i].t.id, embeddable[i].text, vec);
          result.nodesEmbedded += 1;
        }
      }

      log(`  进度: 已重建 ${result.nodesEmbedded}，失败/跳过 ${result.nodesFailed}（游标 ${nodeCursor.slice(0, 12)}…）`);
    }

    // ── 社区重建 ──
    log("[graph-memory-pro] 开始重建社区向量...");
    let communityCursor = "";
    for (;;) {
      const targets = await listCommunityEmbeddingTargets(driver, communityCursor, batch);
      if (!targets.length) break;
      communityCursor = targets[targets.length - 1].id;

      const { vecs, batchCalls } = await embedTexts(
        embedder,
        targets.map(t => t.summary),
        log,
      );
      result.batches += batchCalls;
      for (let i = 0; i < targets.length; i++) {
        const vec = vecs[i];
        if (!vec) {
          result.communitiesFailed += 1;
          continue;
        }
        await saveCommunityEmbedding(driver, targets[i].id, vec);
        result.communitiesEmbedded += 1;
      }
      log(`  进度: 已重建 ${result.communitiesEmbedded}，失败 ${result.communitiesFailed}`);
    }

    result.durationMs = Date.now() - start;
    log(
      `\n[graph-memory-pro] 重嵌入完成：节点 ${result.nodesEmbedded}（失败/跳过 ${result.nodesFailed}），` +
      `社区 ${result.communitiesEmbedded}（失败 ${result.communitiesFailed}），` +
      `${result.batches} 次 embedding 调用${result.recreatedIndex ? "，索引已重建" : ""}，` +
      `用时 ${(result.durationMs / 1000).toFixed(1)}s`,
    );
    if (result.nodesFailed > 0 || result.communitiesFailed > 0) {
      log("[graph-memory-pro] 提示：失败条目保持无向量，修复端点后再次运行本命令即可增量补齐。");
    }
    return result;
  } finally {
    await closeDriver();
  }
}
