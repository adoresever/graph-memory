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

  constructor(private db: DatabaseSyncInstance, private cfg: GmConfig) {}

  setEmbedFn(fn: EmbedFn): void { this.embed = fn; }

  async recall(query: string): Promise<RecallResult> {
    const limit = this.cfg.recallMaxNodes;

    // ── 两条路径各自独立跑满，不分配额 ──────────────────
    const precise = await this.recallPrecise(query, limit);
    const generalized = await this.recallGeneralized(query, limit);

    // ── 合并去重（全部保留，只去重复节点） ────────────────
    const merged = this.mergeResults(precise, generalized);

    if (process.env.GM_DEBUG) {
      const communities = new Set(merged.nodes.map(n => n.communityId).filter(Boolean));
      console.log(`  [DEBUG] recall merged: precise=${precise.nodes.length}, generalized=${generalized.nodes.length} → final=${merged.nodes.length} nodes, ${merged.edges.length} edges, ${communities.size} communities`);
    }

    return merged;
  }

  /**
   * 精确召回：向量/FTS5 找种子 → 社区扩展 → 图遍历 → PPR 排序
   */
  private async recallPrecise(query: string, limit: number): Promise<RecallResult> {
    let seeds: GmNode[] = [];

    if (this.embed) {
      try {
        const vec = await this.embed(query);
        const scored = vectorSearchWithScore(this.db, vec, Math.ceil(limit / 2));
        seeds = scored.map(s => s.node);

        if (process.env.GM_DEBUG && scored.length > 0) {
          console.log(`  [DEBUG] precise: bestScore=${scored[0].score.toFixed(3)}, seeds=${seeds.length}`);
        }

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
        const vec = await this.embed(query);
        const scoredCommunities = communityVectorSearch(this.db, vec);

        if (scoredCommunities.length > 0) {
          const communityIds = scoredCommunities.map(c => c.id);
          seeds = nodesByCommunityIds(this.db, communityIds, 3);

          if (process.env.GM_DEBUG) {
            console.log(`  [DEBUG] generalized: community vector matched ${scoredCommunities.length} communities: ${scoredCommunities.map(c => `${c.id}(${c.score.toFixed(2)})`).join(", ")}`);
          }
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

    if (process.env.GM_DEBUG) {
      const communities = new Set(filtered.map(n => n.communityId).filter(Boolean));
      console.log(`  [DEBUG] generalized: ${filtered.length} nodes from ${communities.size} communities`);
    }

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
    const embedSource = `${node.name}: ${node.description}\n${node.content.slice(0, 500)}`;
    const hash = createHash("md5").update(embedSource).digest("hex");
    if (getVectorHash(this.db, node.id) === hash) return;
    try {
      const text = embedSource;
      const vec = await this.embed(text);
      if (vec.length) saveVector(this.db, node.id, embedSource, vec);
    } catch { /* 不影响主流程 */ }
  }
}