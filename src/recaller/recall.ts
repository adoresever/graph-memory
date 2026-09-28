/**
 * graph-memory — 跨对话召回
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 *
 * Query recall is deliberately relevance-first: vector ranking is preserved,
 * with FTS5 as an exact-term/failure fallback. Graph centrality is useful for
 * offline graph inspection, but must not displace the memories most similar
 * to the current user question.
 */

import { type DatabaseSyncInstance } from "../store/sqlite.ts";
import { createHash } from "crypto";
import type { GmConfig, RecallResult, GmNode, GmTurnMemory } from "../types.ts";
import type { EmbedFn } from "../engine/embed.ts";
import {
  searchNodes, vectorSearchWithScore,
  graphWalk,
  saveVector, getVectorHash,
  searchTurnMemories, turnMemoryVectorSearchWithScore,
  nodesForTurnMemories, saveTurnVector, getTurnVectorHash,
  getNavigationTriplesForMemories,
  findNavigationSeedTermIds, navigationCandidateTermIds,
  rankTurnMemoryIdsByNavigation, getTurnMemoriesByIds,
  hasTurnMemories,
} from "../store/store.ts";
import { personalizedNavigationPageRank } from "../graph/pagerank.ts";

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
    let queryVector: number[] | undefined;
    if (this.embed) {
      try {
        queryVector = await this.embed(query, "query");
      } catch {
        // The lexical path remains available when the embedding provider is
        // temporarily unavailable.
      }
    }

    const directMemories = this.recallTurnMemories(query, limit, queryVector);
    const seedIds = findNavigationSeedTermIds(
      this.db,
      query,
      directMemories.map(memory => memory.id),
    );
    let graphMemories: GmTurnMemory[] = [];
    let navigationScores = new Map<string, number>();
    if (seedIds.length) {
      const candidateTermIds = navigationCandidateTermIds(this.db, seedIds);
      navigationScores = personalizedNavigationPageRank(
        this.db,
        seedIds,
        candidateTermIds,
        this.cfg,
      ).scores;
      graphMemories = getTurnMemoriesByIds(
        this.db,
        rankTurnMemoryIdsByNavigation(this.db, navigationScores),
      );
    }
    const turnMemories = this.mergeTurnMemoryRanks(directMemories, graphMemories, limit);
    if (turnMemories.length) {
      const memoryIds = turnMemories.map(memory => memory.id);
      const nodes = nodesForTurnMemories(
        this.db,
        memoryIds,
        limit,
      );
      const { edges } = graphWalk(this.db, nodes.map(node => node.id), 0);
      return {
        nodes,
        edges,
        turnMemories,
        triples: getNavigationTriplesForMemories(this.db, memoryIds, navigationScores),
      };
    }

    // Databases created before the turn-memory migration remain searchable.
    // The same confidence rule applies; a legacy node match cannot bypass it.
    return this.recallPrecise(query, limit, queryVector, hasTurnMemories(this.db));
  }

  /**
   * Fuse independent summary and graph ranks without mixing incomparable
   * cosine and PageRank score scales. A memory supported by both routes rises;
   * exact summary matches keep tie priority over graph-only expansion.
   */
  private mergeTurnMemoryRanks(
    direct: GmTurnMemory[],
    graph: GmTurnMemory[],
    limit: number,
  ): GmTurnMemory[] {
    const candidates = new Map<string, {
      memory: GmTurnMemory;
      score: number;
      directRank: number;
    }>();
    direct.forEach((memory, index) => {
      candidates.set(memory.id, {
        memory,
        score: 1 / (index + 1),
        directRank: index,
      });
    });
    graph.forEach((memory, index) => {
      const existing = candidates.get(memory.id);
      if (existing) {
        existing.score += 1 / (index + 1);
      } else {
        candidates.set(memory.id, {
          memory,
          score: 1 / (index + 1),
          directRank: Number.POSITIVE_INFINITY,
        });
      }
    });
    return Array.from(candidates.values())
      .sort((left, right) =>
        right.score - left.score
        || left.directRank - right.directRank
        || right.memory.updatedAt - left.memory.updatedAt
        || left.memory.id.localeCompare(right.memory.id)
      )
      .slice(0, limit)
      .map(candidate => candidate.memory);
  }

  private recallTurnMemories(
    query: string,
    limit: number,
    queryVector?: number[],
  ): GmTurnMemory[] {
    const lexical = searchTurnMemories(this.db, query, limit);
    const threshold = this.cfg.semanticScoreThreshold;
    const semantic = queryVector && threshold !== undefined
      ? turnMemoryVectorSearchWithScore(this.db, queryVector, limit, threshold)
      : [];
    const selected: GmTurnMemory[] = [];
    const seen = new Set<string>();
    const append = (memory: GmTurnMemory) => {
      if (selected.length >= limit || seen.has(memory.id)) return;
      seen.add(memory.id);
      selected.push(memory);
    };
    for (const { memory } of semantic) append(memory);
    for (const memory of lexical) append(memory);
    return selected;
  }

  /**
   * Preserve semantic rank. FTS5 contributes exact terms and is the complete
   * fallback when the embedding provider is absent or temporarily fails.
   */
  private async recallPrecise(
    query: string,
    limit: number,
    queryVector?: number[],
    legacyOnly = false,
  ): Promise<RecallResult> {
    const lexical = searchNodes(this.db, query, limit, legacyOnly);
    const threshold = this.cfg.semanticScoreThreshold;
    const semantic = queryVector && threshold !== undefined
      ? vectorSearchWithScore(
          this.db,
          queryVector,
          limit,
          threshold,
          legacyOnly,
        )
      : [];
    const selected: GmNode[] = [];
    const selectedIds = new Set<string>();
    const append = (node: GmNode) => {
      if (selected.length >= limit || selectedIds.has(node.id)) return;
      selected.push(node);
      selectedIds.add(node.id);
    };
    for (const { node } of semantic) append(node);
    for (const node of lexical) append(node);
    if (!selected.length) return { nodes: [], edges: [], turnMemories: [], triples: [] };

    // Depth zero asks the store only for edges whose two endpoints are direct
    // query matches. No unrelated graph hub is allowed to enter the prompt.
    const { edges } = graphWalk(this.db, selected.map(node => node.id), 0);
    return { nodes: selected, edges, turnMemories: [], triples: [] };
  }

  /** 异步同步 embedding，不阻塞主流程 */
  async syncEmbed(node: GmNode): Promise<void> {
    if (!this.embed) return;
    const temporal = Object.keys(node.temporal).length ? `\n时间语义: ${JSON.stringify(node.temporal)}` : "";
    const text = `${node.name}: ${node.description}\n${node.content}${temporal}`;
    const hashInput = this.embeddingFingerprint ? `${this.embeddingFingerprint}\0${text}` : text;
    const hash = createHash("md5").update(hashInput).digest("hex");
    if (getVectorHash(this.db, node.id) === hash) return;
    try {
      const vec = await this.embed(text, "db");
      if (vec.length) saveVector(this.db, node.id, hashInput, vec);
    } catch { /* 不影响主流程 */ }
  }

  /** Keep the compact episodic layer independently searchable. */
  async syncTurnMemoryEmbed(memory: GmTurnMemory): Promise<void> {
    if (!this.embed) return;
    const text = `${memory.outcome}: ${memory.summary}`;
    const hashInput = this.embeddingFingerprint ? `${this.embeddingFingerprint}\0${text}` : text;
    const hash = createHash("md5").update(hashInput).digest("hex");
    if (getTurnVectorHash(this.db, memory.id) === hash) return;
    try {
      const vec = await this.embed(text, "db");
      if (vec.length) saveTurnVector(this.db, memory.id, hashInput, vec);
    } catch { /* 不影响主流程 */ }
  }
}
