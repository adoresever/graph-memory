/**
 * graph-memory — 跨对话召回
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 *
 * 并行双路径召回（两条路径同时跑，合并去重）：
 *
 * 精确路径（向量/FTS5 → 社区扩展 → 图遍历 → PPR 排序）：
 *   找到和当前查询语义相关的具体三元组
 *
 * 泛化路径（社区代表节点 → 图遍历 → PPR 排序）：
 *   提供跨领域的全局概览，覆盖精确路径可能遗漏的知识域
 *
 * 合并策略：精确路径的结果优先（PPR 分数更高），
 *           泛化路径补充精确路径未覆盖的社区。
 */

import { DatabaseSync, type DatabaseSyncInstance } from "../store/sqlite.ts";
import { createHash } from "crypto";
import type { GmConfig, RecallResult, GmNode, GmEdge } from "../types.ts";
import type { EmbedFn } from "../engine/embed.ts";
import {
  searchNodes, vectorSearchWithScore,
  graphWalk, communityRepresentatives,
  communityVectorSearch, nodesByCommunityIds,
  saveVector, getVectorHash,
} from "../store/store.ts";
import { getCommunityPeers } from "../graph/community.ts";
import { personalizedPageRank } from "../graph/pagerank.ts";

export class Recaller {
  private embed: EmbedFn | null = null;
  private embeddingFingerprint = "";

  constructor(private db: DatabaseSyncInstance, private cfg: GmConfig) {}

  setEmbedFn(fn: EmbedFn, fingerprint = ""): void {
    this.embed = fn;
    this.embeddingFingerprint = fingerprint;
  }

  async recall(query: string, options: {
    /** Minimum cosine score for semantic seeds. Explicit searches keep 0.35. */
    minSemanticScore?: number;
    /** Allow query-independent community representatives as a broad fallback. */
    allowBroadFallback?: boolean;
  } = {}): Promise<RecallResult> {
    const limit = this.cfg.recallMaxNodes;
    const minSemanticScore = options.minSemanticScore ?? 0.35;
    const allowBroadFallback = options.allowBroadFallback ?? true;
    let queryVector: number[] | undefined;
    if (this.embed) {
      try {
        queryVector = await this.embed(query, "query");
      } catch {
        // The lexical path remains available when the embedding provider is
        // temporarily unavailable.
      }
    }

    // ── 两条路径各自独立跑满，不分配额 ──────────────────
    const precise = await this.recallPrecise(query, limit, queryVector, minSemanticScore);
    const generalized = await this.recallGeneralized(
      limit, queryVector, minSemanticScore, allowBroadFallback,
    );

    // ── 合并去重（全部保留，只去重复节点） ────────────────
    const merged = this.mergeResults(precise, generalized);

    return merged;
  }

  /**
   * 精确召回：向量/FTS5 找种子 → 社区扩展 → 图遍历 → PPR 排序
   */
  private async recallPrecise(
    query: string,
    limit: number,
    queryVector?: number[],
    minSemanticScore = 0.35,
  ): Promise<RecallResult> {
    // Always combine semantic and lexical retrieval. A vector-only branch
    // misses exact identifiers; an FTS-only fallback misses paraphrases.
    const lexical = searchNodes(this.db, query, limit);
    const semantic = queryVector
      ? vectorSearchWithScore(this.db, queryVector, limit, minSemanticScore)
      : [];
    const relevance = new Map<string, number>();
    const byId = new Map<string, GmNode>();
    semantic.forEach(({ node, score }) => {
      byId.set(node.id, node);
      relevance.set(node.id, Math.max(relevance.get(node.id) ?? 0, score));
    });
    lexical.forEach((node, index) => {
      byId.set(node.id, node);
      // Reciprocal rank is bounded but gives exact terms a meaningful boost.
      relevance.set(node.id, (relevance.get(node.id) ?? 0) + 0.35 / (index + 1));
    });
    const seeds = Array.from(byId.values())
      .sort((a, b) => (relevance.get(b.id) ?? 0) - (relevance.get(a.id) ?? 0))
      .slice(0, limit);

    if (!seeds.length) return { nodes: [], edges: [], tokenEstimate: 0 };

    const seedIds = seeds.map(n => n.id);

    // 社区扩展
    const expandedIds = new Set(seedIds);
    for (const seed of seeds) {
      const peers = getCommunityPeers(this.db, seed.id, 2);
      for (const peerId of peers) expandedIds.add(peerId);
    }

    // 图遍历拿三元组
    const { nodes, edges } = graphWalk(
      this.db,
      Array.from(expandedIds),
      this.cfg.recallMaxDepth,
    );

    if (!nodes.length) return { nodes: [], edges: [], tokenEstimate: 0 };

    // 个性化 PageRank 排序
    const candidateIds = nodes.map(n => n.id);
    const { scores: pprScores } = personalizedPageRank(
      this.db, seedIds, candidateIds, this.cfg, relevance,
    );

    const filtered = nodes
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
      tokenEstimate: this.estimateTokens(filtered),
    };
  }

  /**
   * 泛化召回：社区向量搜索 → 取匹配社区的成员 → 图遍历 → PPR 排序
   *
   * 有社区向量时：query vs 社区 embedding 匹配，按相似度排序社区
   * 无社区向量时：fallback 到 communityRepresentatives（按时间取代表节点）
   */
  private async recallGeneralized(
    limit: number,
    queryVector?: number[],
    minSemanticScore = 0.35,
    allowBroadFallback = true,
  ): Promise<RecallResult> {
    let seeds: GmNode[] = [];

    // 优先用社区向量搜索
    if (queryVector) {
      try {
        const scoredCommunities = communityVectorSearch(this.db, queryVector, minSemanticScore);

        if (scoredCommunities.length > 0) {
          const communityIds = scoredCommunities.map(c => c.id);
          seeds = nodesByCommunityIds(this.db, communityIds, 3);

        }
      } catch {
        // embedding 失败，fallback
      }
    }

    // fallback：按时间取社区代表节点
    if (!seeds.length && allowBroadFallback) {
      seeds = communityRepresentatives(this.db, 2);
    }

    if (!seeds.length) return { nodes: [], edges: [], tokenEstimate: 0 };

    const seedIds = seeds.map(n => n.id);
    const { nodes, edges } = graphWalk(this.db, seedIds, 1);
    if (!nodes.length) return { nodes: [], edges: [], tokenEstimate: 0 };

    const candidateIds = nodes.map(n => n.id);
    const { scores: pprScores } = personalizedPageRank(
      this.db, seedIds, candidateIds, this.cfg,
    );

    const filtered = nodes
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
      tokenEstimate: this.estimateTokens(filtered),
    };
  }

  /**
   * 合并两条路径的结果：全部保留，只去重复节点
   */
  private mergeResults(precise: RecallResult, generalized: RecallResult): RecallResult {
    const nodeMap = new Map<string, GmNode>();
    const edgeMap = new Map<string, GmEdge>();

    // 精确路径全部入场
    for (const n of precise.nodes) nodeMap.set(n.id, n);
    for (const e of precise.edges) edgeMap.set(e.id, e);

    // 泛化路径去重后全部入场
    for (const n of generalized.nodes) {
      if (!nodeMap.has(n.id)) nodeMap.set(n.id, n);
    }

    // 合并边：两端都在最终节点集中的边才保留
    const finalIds = new Set(nodeMap.keys());
    for (const e of generalized.edges) {
      if (!edgeMap.has(e.id) && finalIds.has(e.fromId) && finalIds.has(e.toId)) {
        edgeMap.set(e.id, e);
      }
    }

    const nodes = Array.from(nodeMap.values());
    const edges = Array.from(edgeMap.values());

    return {
      nodes,
      edges,
      tokenEstimate: this.estimateTokens(nodes),
    };
  }

  private estimateTokens(nodes: GmNode[]): number {
    return Math.ceil(nodes.reduce((s, n) => s + n.content.length + n.description.length, 0) / 3);
  }

  /** 异步同步 embedding，不阻塞主流程 */
  async syncEmbed(node: GmNode): Promise<void> {
    if (!this.embed) return;
    const text = `${node.name}: ${node.description}\n${node.content}`;
    const hashInput = this.embeddingFingerprint ? `${this.embeddingFingerprint}\0${text}` : text;
    const hash = createHash("md5").update(hashInput).digest("hex");
    if (getVectorHash(this.db, node.id) === hash) return;
    try {
      const vec = await this.embed(text, "db");
      if (vec.length) saveVector(this.db, node.id, hashInput, vec);
    } catch { /* 不影响主流程 */ }
  }
}
