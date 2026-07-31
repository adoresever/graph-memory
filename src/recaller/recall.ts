/**
 * graph-memory-pro — 跨对话召回 (Neo4j 版)
 *
 * 双路径召回：精确路径（向量搜索） + 泛化路径（社区代表节点）
 */

import type { Driver } from "neo4j-driver";
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

  constructor(private driver: Driver, private cfg: GmConfig) {}

  setEmbedFn(fn: EmbedFn): void { this.embed = fn; }

  async recall(query: string): Promise<RecallResult> {
    const limit = this.cfg.recallMaxNodes;

    const precise = await this.recallPrecise(query, limit);
    const generalized = await this.recallGeneralized(query, limit);
    const merged = this.mergeResults(precise, generalized);

    return merged;
  }

  /**
   * 精确召回：向量搜索 → 社区扩展 → 图遍历 → PPR 排序
   */
  private async recallPrecise(query: string, limit: number): Promise<RecallResult> {
    let seeds: GmNode[] = [];

    if (this.embed) {
      try {
        const vec = await this.embed(query);
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

    if (!seeds.length) return { nodes: [], edges: [], tokenEstimate: 0 };

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

    if (!nodes.length) return { nodes: [], edges: [], tokenEstimate: 0 };

    // PPR 排序
    const candidateIds = nodes.map(n => n.id);
    const { scores: pprScores } = await personalizedPageRank(
      this.driver, seedIds, candidateIds, this.cfg,
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
   * 泛化召回：社区向量搜索 → 图遍历 → PPR 排序
   */
  private async recallGeneralized(query: string, limit: number): Promise<RecallResult> {
    let seeds: GmNode[] = [];

    if (this.embed) {
      try {
        const vec = await this.embed(query);
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

    if (!seeds.length) return { nodes: [], edges: [], tokenEstimate: 0 };

    const seedIds = seeds.map(n => n.id);
    const { nodes, edges } = await graphWalk(this.driver, seedIds, 1);
    if (!nodes.length) return { nodes: [], edges: [], tokenEstimate: 0 };

    const candidateIds = nodes.map(n => n.id);
    const { scores: pprScores } = await personalizedPageRank(
      this.driver, seedIds, candidateIds, this.cfg,
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
    return { nodes, edges, tokenEstimate: this.estimateTokens(nodes) };
  }

  private estimateTokens(nodes: GmNode[]): number {
    return Math.ceil(nodes.reduce((s, n) => s + n.content.length + n.description.length, 0) / 3);
  }

  async syncEmbed(node: GmNode): Promise<void> {
    if (!this.embed) return;
    const hash = createHash("md5").update(node.content).digest("hex");
    const existingHash = await getVectorHash(this.driver, node.id);
    if (existingHash === hash) return;
    try {
      const text = `${node.name}: ${node.description}\n${node.content.slice(0, 500)}`;
      const vec = await this.embed(text);
      if (vec.length) await saveVector(this.driver, node.id, node.content, vec);
    } catch {}
  }
}
