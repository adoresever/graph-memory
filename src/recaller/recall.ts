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

import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
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

  async recall(query: string): Promise<RecallResult> {
    const limit = this.cfg.recallMaxNodes;

    // ── 两条路径各自独立跑满，不分配额 ──────────────────
    const precise = await this.recallPrecise(query, limit);
    const generalized = await this.recallGeneralized(query, limit);

    // ── 合并：精确路径优先，泛化路径只补精确未覆盖的社区，总量封顶 limit ──
    const merged = this.mergeResults(precise, generalized, limit);

    return merged;
  }

  /**
   * 精确召回：向量/FTS5 找种子 → 社区扩展 → 图遍历 → PPR 排序
   */
  private async recallPrecise(query: string, limit: number): Promise<RecallResult> {
    let seeds: GmNode[] = [];

    if (this.embed) {
      try {
        const vec = await this.embed(query, "query");
        const scored = vectorSearchWithScore(this.db, vec, Math.ceil(limit / 2));
        seeds = scored.map(s => s.node);

        // 向量结果不足时补 FTS5
        if (seeds.length < 2) {
          const fts = searchNodes(this.db, query, limit);
          const seen = new Set(seeds.map(n => n.id));
          seeds.push(...fts.filter(n => !seen.has(n.id)));
        }
      } catch {
        seeds = searchNodes(this.db, query, limit);
      }
    } else {
      seeds = searchNodes(this.db, query, limit);
    }

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
      this.db, seedIds, candidateIds, this.cfg,
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
  private async recallGeneralized(query: string, limit: number): Promise<RecallResult> {
    let seeds: GmNode[] = [];

    // 优先用社区向量搜索
    if (this.embed) {
      try {
        const vec = await this.embed(query, "query");
        const scoredCommunities = communityVectorSearch(this.db, vec);

        if (scoredCommunities.length > 0) {
          const communityIds = scoredCommunities.map(c => c.id);
          seeds = nodesByCommunityIds(this.db, communityIds, 3);

        }
      } catch {
        // embedding 失败，fallback
      }
    }

    // fallback：按时间取社区代表节点
    if (!seeds.length) {
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
   * 合并两条路径的结果：精确路径优先，泛化路径只补充精确路径未覆盖的社区，总量封顶 limit。
   *
   * 之前两条路径各自跑满 limit 后全量合并，节点数可能翻倍；且泛化路径常补进与精确
   * 路径同社区的高度重复节点。现在泛化路径只在「目标节点属于精确路径未覆盖社区」时才
   * 补入，既保留跨领域概览，又避免同社区冗余，同时把总节点数稳定封顶在 limit。
   */
  private mergeResults(precise: RecallResult, generalized: RecallResult, limit: number): RecallResult {
    const nodeMap = new Map<string, GmNode>();
    const edgeMap = new Map<string, GmEdge>();

    // 精确路径全部入场（已按 PPR 排序并 slice 到 limit）
    for (const n of precise.nodes) nodeMap.set(n.id, n);
    for (const e of precise.edges) edgeMap.set(e.id, e);

    // 泛化路径：只补精确路径未覆盖的社区，直到达到总配额
    const preciseCommunityIds = new Set(
      precise.nodes.map(n => n.communityId).filter((cid): cid is string => Boolean(cid)),
    );
    for (const n of generalized.nodes) {
      if (nodeMap.size >= limit) break;
      if (nodeMap.has(n.id)) continue;
      // 泛化节点若属于精确路径已覆盖的社区，视为冗余，跳过
      if (n.communityId && preciseCommunityIds.has(n.communityId)) continue;
      nodeMap.set(n.id, n);
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
    const text = `${node.name}: ${node.description}\n${node.content.slice(0, 500)}`;
    const hashInput = this.embeddingFingerprint ? `${this.embeddingFingerprint}\0${text}` : text;
    const hash = createHash("md5").update(hashInput).digest("hex");
    if (getVectorHash(this.db, node.id) === hash) return;
    try {
      const vec = await this.embed(text, "db");
      if (vec.length) saveVector(this.db, node.id, hashInput, vec);
    } catch { /* 不影响主流程 */ }
  }
}
