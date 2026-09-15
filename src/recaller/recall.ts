/**
 * graph-memory-pro — 跨对话召回 (Neo4j 版)
 *
 * 双路径召回：精确路径（向量搜索） + 泛化路径（社区代表节点）
 */

import type { Driver } from "neo4j-driver";
import { createHash } from "crypto";
import type { GmConfig, RecallResult, GmNode, GmEdge } from "../types.ts";
import type { EmbedFn, EmbedBatchFn } from "../engine/embed.ts";
import {
  searchNodes, vectorSearchWithScore,
  graphWalk, communityRepresentatives,
  communityVectorSearch, nodesByCommunityIds,
  saveVector, getVectorHash, getVectorHashes, saveVectors,
} from "../store/store.ts";
import { getCommunityPeers } from "../graph/community.ts";
import { personalizedPageRank } from "../graph/pagerank.ts";
import { QueryVecCache } from "./query-cache.ts";

/** 批量嵌入分块大小：对齐 reembed 默认批（32），兼顾服务端批量上限与吞吐。 */
const SYNC_EMBED_BATCH = 32;

export function buildNodeEmbeddingText(
  node: Pick<GmNode, "name" | "description" | "content">,
): string {
  return `${node.name}: ${node.description}\n${node.content.slice(0, 500)}`;
}

// ─── 时间筛选 ───────────────────────────────────────────────

type RecallTimeField = "createdAt" | "updatedAt";

interface RecallOptions {
  /** ISO 8601 字符串；只返回 timeField 对应时刻 >= after 的节点 */
  after?: string;
  /** ISO 8601 字符串；只返回 timeField 对应时刻 <= before 的节点 */
  before?: string;
  /** 筛选字段，默认 createdAt */
  timeField?: RecallTimeField;
}

export interface ParsedTimeRange {
  sinceMs: number;
  untilMs: number;
  field: RecallTimeField;
}

/**
 * 解析时间筛选参数为 epoch 毫秒区间。
 * - 仅 after：[after, +∞)
 * - 仅 before：[0, before]（节点时间均为正 epoch，下界 0 即"无下界"）
 * - 同时传：[after, before]
 * 非法 ISO 字符串、区间反向均抛错。
 */
export function parseTimeRange(opts: RecallOptions): ParsedTimeRange {
  const field = opts.timeField ?? "createdAt";
  const sinceMs = opts.after ? parseIso(opts.after) : 0;
  const untilMs = opts.before ? parseIso(opts.before) : Number.MAX_SAFE_INTEGER;
  if (opts.after && Number.isNaN(sinceMs)) {
    throw new Error(`[graph-memory-pro] invalid "after" time: ${opts.after}`);
  }
  if (opts.before && Number.isNaN(untilMs)) {
    throw new Error(`[graph-memory-pro] invalid "before" time: ${opts.before}`);
  }
  if (sinceMs > untilMs) {
    throw new Error(`[graph-memory-pro] "after" must be earlier than "before"`);
  }
  return { sinceMs, untilMs, field };
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseIso(s: string): number {
  if (DATE_ONLY_RE.test(s)) return Date.parse(`${s}T00:00:00Z`);
  return Date.parse(s);
}

/** 判断节点是否落在时间区间内（闭区间，含两端） */
export function matchTimeRange(
  node: Pick<GmNode, "createdAt" | "updatedAt">,
  range: ParsedTimeRange,
): boolean {
  const t = node[range.field];
  return t >= range.sinceMs && t <= range.untilMs;
}

export class Recaller {
  private embed: EmbedFn | null = null;
  private embedBatch: EmbedBatchFn | null = null;
  /** 查询向量 LRU：同文本重复召回省一次 embedding 调用（db 模式不入缓存）。 */
  private queryVecCache = new QueryVecCache();

  constructor(private driver: Driver, private cfg: GmConfig) {}

  setEmbedFn(fn: EmbedFn): void {
    this.embed = fn;
    // 端点可能刚从失败恢复/模型切换：旧向量与新端点不可混用
    this.queryVecCache.clear();
  }

  /** 注入批量 embedder（createEmbedder.embedBatch）；运行时批量同步向量用。 */
  setEmbedBatchFn(fn: EmbedBatchFn): void {
    this.embedBatch = fn;
    this.queryVecCache.clear();
  }

  /** 是否已接入 embedding（启动 probe 成功或会话级 re-probe 成功）。 */
  hasEmbedFn(): boolean { return this.embed !== null; }

  /** 只读暴露 embedFn（maintenance / gm_maintain 需要），替代 (recaller as any).embed。 */
  get embedFn(): EmbedFn | null { return this.embed; }

  async recall(query: string, options?: RecallOptions): Promise<RecallResult> {
    const limit = this.cfg.recallMaxNodes;
    const timeRange = options ? parseTimeRange(options) : null;

    // query 向量只算一次，两条路径共享；失败统一落 null（各路径走文本兜底）。
    // LRU 命中时零 API 调用（同会话重复查询：before_agent_start ↔ assemble ↔ gm_search）。
    // 双路径并行执行 —— 原串行 + 各自 embed 会把 2 次调用放大成 4 次 API 调用
    // 与 4 次图遍历，全部压在调用方的预算窗口内。
    const cachedVec = this.queryVecCache.get(query);
    const embedPromise: Promise<number[] | null> = this.embed
      ? cachedVec
        ? Promise.resolve(cachedVec)
        : this.embed(query, "query")
          .then((vec) => { this.queryVecCache.set(query, vec); return vec; })
          .catch(() => null)
      : Promise.resolve(null);

    const [precise, generalized] = await Promise.all([
      this.recallPrecise(query, limit, timeRange, embedPromise),
      this.recallGeneralized(limit, timeRange, embedPromise),
    ]);
    const merged = this.mergeResults(precise, generalized);

    return merged;
  }

  /**
   * 精确召回：向量搜索 → 社区扩展 → 图遍历 → PPR 排序
   */
  private async recallPrecise(
    query: string,
    limit: number,
    timeRange: ParsedTimeRange | null,
    embedPromise: Promise<number[] | null>,
  ): Promise<RecallResult> {
    let seeds: GmNode[] = [];

    const vec = await embedPromise;
    if (vec) {
      try {
        const scored = await vectorSearchWithScore(this.driver, vec, Math.ceil(limit / 2));
        seeds = scored.map(s => s.node);

        if (seeds.length < 2) {
          const fts = await searchNodes(this.driver, query, limit);
          const seen = new Set(seeds.map(n => n.id));
          seeds.push(...fts.filter(n => !seen.has(n.id)));
        }
      } catch {
        seeds = await searchNodes(this.driver, query, limit);
      }
    } else {
      seeds = await searchNodes(this.driver, query, limit);
    }

    if (!seeds.length) return { nodes: [], edges: [] };

    const seedIds = seeds.map(n => n.id);

    // 社区扩展
    const expandedIds = new Set(seedIds);
    for (const seed of seeds) {
      const peers = await getCommunityPeers(this.driver, seed.id, 2);
      for (const peerId of peers) expandedIds.add(peerId);
    }

    // 图遍历
    const { nodes, edges } = await graphWalk(
      this.driver,
      Array.from(expandedIds),
      this.cfg.recallMaxDepth,
    );

    if (!nodes.length) return { nodes: [], edges: [] };

    // PPR 排序
    const candidateIds = nodes.map(n => n.id);
    const { scores: pprScores } = await personalizedPageRank(
      this.driver, seedIds, candidateIds, this.cfg,
    );

    // PPR 排序后的过滤/截断尾块与 recallGeneralized 结构一致，但 tiebreak
    // 顺序刻意相反：precise 以 validatedCount 决胜（精确命中的知识更受认可），
    // generalized 以 updatedAt 决胜（泛化探索偏向新鲜）。改动前先同步
    // test/ablation.study.test.ts 的镜像 harness。
    const filtered = nodes
      .filter(n => !timeRange || matchTimeRange(n, timeRange))
      .sort((a, b) =>
        (pprScores.get(b.id) || 0) - (pprScores.get(a.id) || 0) ||
        b.validatedCount - a.validatedCount ||
        b.updatedAt - a.updatedAt
      )
      .slice(0, limit);

    const ids = new Set(filtered.map(n => n.id));
    return {
      nodes: filtered,
      edges: edges.filter(e => ids.has(e.fromId) && ids.has(e.toId)),
    };
  }

  /**
   * 泛化召回：社区向量搜索 → 图遍历 → PPR 排序
   */
  private async recallGeneralized(
    limit: number,
    timeRange: ParsedTimeRange | null,
    embedPromise: Promise<number[] | null>,
  ): Promise<RecallResult> {
    let seeds: GmNode[] = [];

    const vec = await embedPromise;
    if (vec) {
      try {
        const scoredCommunities = await communityVectorSearch(this.driver, vec);

        if (scoredCommunities.length > 0) {
          const communityIds = scoredCommunities.map(c => c.id);
          seeds = await nodesByCommunityIds(this.driver, communityIds, 3);

        }
      } catch {}
    }

    if (!seeds.length) {
      seeds = await communityRepresentatives(this.driver, 2);
    }

    if (!seeds.length) return { nodes: [], edges: [] };

    const seedIds = seeds.map(n => n.id);
    const { nodes, edges } = await graphWalk(this.driver, seedIds, 1);
    if (!nodes.length) return { nodes: [], edges: [] };

    const candidateIds = nodes.map(n => n.id);
    const { scores: pprScores } = await personalizedPageRank(
      this.driver, seedIds, candidateIds, this.cfg,
    );

    // tiebreak 与 recallPrecise 相反（updatedAt 决胜）——见该处的注释
    const filtered = nodes
      .filter(n => !timeRange || matchTimeRange(n, timeRange))
      .sort((a, b) =>
        (pprScores.get(b.id) || 0) - (pprScores.get(a.id) || 0) ||
        b.updatedAt - a.updatedAt ||
        b.validatedCount - a.validatedCount
      )
      .slice(0, limit);

    const ids = new Set(filtered.map(n => n.id));
    return {
      nodes: filtered,
      edges: edges.filter(e => ids.has(e.fromId) && ids.has(e.toId)),
    };
  }

  private mergeResults(precise: RecallResult, generalized: RecallResult): RecallResult {
    const nodeMap = new Map<string, GmNode>();
    const edgeMap = new Map<string, GmEdge>();

    for (const n of precise.nodes) nodeMap.set(n.id, n);
    for (const e of precise.edges) edgeMap.set(e.id, e);

    for (const n of generalized.nodes) {
      if (!nodeMap.has(n.id)) nodeMap.set(n.id, n);
    }

    const finalIds = new Set(nodeMap.keys());
    for (const e of generalized.edges) {
      if (!edgeMap.has(e.id) && finalIds.has(e.fromId) && finalIds.has(e.toId)) {
        edgeMap.set(e.id, e);
      }
    }

    const nodes = Array.from(nodeMap.values());
    const edges = Array.from(edgeMap.values());
    return { nodes, edges };
  }


  async syncEmbed(node: GmNode): Promise<void> {
    if (!this.embed && !this.embedBatch) return;
    const text = buildNodeEmbeddingText(node);
    const hash = createHash("md5").update(text).digest("hex");
    const existingHash = await getVectorHash(this.driver, node.id);
    if (existingHash === hash) return;
    try {
      const vec = this.embed
        ? await this.embed(text, "db")
        : (await this.embedBatch!([text], "db"))[0];
      if (vec.length) await saveVector(this.driver, node.id, text, vec, hash);
    } catch {}
  }

  /**
   * 批量同步节点向量（embedding 成本控制）：一批提取产出 N 个节点时，
   * N 次单发 API + N 次 hash 查询 → 一次批量 embed + 一次 UNWIND 批读写。
   * 与 syncEmbed 相同的 contentHash 短路语义（未变节点零调用）；
   * 按 SYNC_EMBED_BATCH 分块（服务端批量上限保护），单块失败 fail-soft 跳过。
   * MiniMax 的 texts+type 批量格式由 embedder 的 embedBatch 内部处理。
   */
  async syncEmbedBatch(nodes: GmNode[]): Promise<void> {
    if (!nodes.length) return;
    if (!this.embed && !this.embedBatch) return;

    const targets = nodes.map((node) => {
      const text = buildNodeEmbeddingText(node);
      return { node, text, hash: createHash("md5").update(text).digest("hex") };
    });

    let existing: Map<string, string | null>;
    try {
      existing = await getVectorHashes(this.driver, targets.map((t) => t.node.id));
    } catch {
      return; // hash 批查失败：fail-soft，与单发路径的吞错策略一致
    }
    const pending = targets.filter((t) => existing.get(t.node.id) !== t.hash);
    if (!pending.length) return;

    if (!this.embedBatch) {
      // 无批量能力（仅 setEmbedFn 的旧接线）：退回逐节点单发
      for (const t of pending) {
        try {
          const vec = await this.embed!(t.text, "db");
          if (vec.length) await saveVector(this.driver, t.node.id, t.text, vec, t.hash);
        } catch {}
      }
      return;
    }

    for (let i = 0; i < pending.length; i += SYNC_EMBED_BATCH) {
      const chunk = pending.slice(i, i + SYNC_EMBED_BATCH);
      try {
        const vecs = await this.embedBatch(chunk.map((t) => t.text), "db");
        if (vecs.length !== chunk.length) continue; // 数量校验失败：parse 层应已抛错，双保险
        await saveVectors(this.driver, chunk.map((t, j) => ({
          nodeId: t.node.id, content: t.text, vec: vecs[j], hash: t.hash,
        })));
      } catch {}
    }
  }
}
