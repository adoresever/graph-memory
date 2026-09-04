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
import { createHash } from "crypto";
import { searchNodes, vectorSearchWithScore, graphWalk, communityRepresentatives, communityVectorSearch, nodesByCommunityIds, saveVector, getVectorHash, } from "../store/store.js";
import { getCommunityPeers } from "../graph/community.js";
import { personalizedPageRank } from "../graph/pagerank.js";
export class Recaller {
    db;
    cfg;
    embed = null;
    embeddingFingerprint = "";
    constructor(db, cfg) {
        this.db = db;
        this.cfg = cfg;
    }
    setEmbedFn(fn, fingerprint = "") {
        this.embed = fn;
        this.embeddingFingerprint = fingerprint;
    }
    async recall(query, options = {}) {
        const limit = this.cfg.recallMaxNodes;
        const minSemanticScore = options.minSemanticScore ?? 0.35;
        const allowBroadFallback = options.allowBroadFallback ?? true;
        let queryVector;
        if (this.embed) {
            try {
                queryVector = await this.embed(query, "query");
            }
            catch {
                // The lexical path remains available when the embedding provider is
                // temporarily unavailable.
            }
        }
        // ── 两条路径各自独立跑满，不分配额 ──────────────────
        const precise = await this.recallPrecise(query, limit, queryVector, minSemanticScore);
        const generalized = await this.recallGeneralized(limit, queryVector, minSemanticScore, allowBroadFallback);
        // ── 合并去重（全部保留，只去重复节点） ────────────────
        const merged = this.mergeResults(precise, generalized);
        return merged;
    }
    /**
     * 精确召回：向量/FTS5 找种子 → 社区扩展 → 图遍历 → PPR 排序
     */
    async recallPrecise(query, limit, queryVector, minSemanticScore = 0.35) {
        // Always combine semantic and lexical retrieval. A vector-only branch
        // misses exact identifiers; an FTS-only fallback misses paraphrases.
        const lexical = searchNodes(this.db, query, limit);
        const semantic = queryVector
            ? vectorSearchWithScore(this.db, queryVector, limit, minSemanticScore)
            : [];
        const relevance = new Map();
        const byId = new Map();
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
        if (!seeds.length)
            return { nodes: [], edges: [], tokenEstimate: 0 };
        const seedIds = seeds.map(n => n.id);
        // 社区扩展
        const expandedIds = new Set(seedIds);
        for (const seed of seeds) {
            const peers = getCommunityPeers(this.db, seed.id, 2);
            for (const peerId of peers)
                expandedIds.add(peerId);
        }
        // 图遍历拿三元组
        const { nodes, edges } = graphWalk(this.db, Array.from(expandedIds), this.cfg.recallMaxDepth);
        if (!nodes.length)
            return { nodes: [], edges: [], tokenEstimate: 0 };
        // 个性化 PageRank 排序
        const candidateIds = nodes.map(n => n.id);
        const { scores: pprScores } = personalizedPageRank(this.db, seedIds, candidateIds, this.cfg, relevance);
        const filtered = nodes
            .sort((a, b) => (pprScores.get(b.id) || 0) - (pprScores.get(a.id) || 0) ||
            b.validatedCount - a.validatedCount ||
            b.updatedAt - a.updatedAt)
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
    async recallGeneralized(limit, queryVector, minSemanticScore = 0.35, allowBroadFallback = true) {
        let seeds = [];
        // 优先用社区向量搜索
        if (queryVector) {
            try {
                const scoredCommunities = communityVectorSearch(this.db, queryVector, minSemanticScore);
                if (scoredCommunities.length > 0) {
                    const communityIds = scoredCommunities.map(c => c.id);
                    seeds = nodesByCommunityIds(this.db, communityIds, 3);
                }
            }
            catch {
                // embedding 失败，fallback
            }
        }
        // fallback：按时间取社区代表节点
        if (!seeds.length && allowBroadFallback) {
            seeds = communityRepresentatives(this.db, 2);
        }
        if (!seeds.length)
            return { nodes: [], edges: [], tokenEstimate: 0 };
        const seedIds = seeds.map(n => n.id);
        const { nodes, edges } = graphWalk(this.db, seedIds, 1);
        if (!nodes.length)
            return { nodes: [], edges: [], tokenEstimate: 0 };
        const candidateIds = nodes.map(n => n.id);
        const { scores: pprScores } = personalizedPageRank(this.db, seedIds, candidateIds, this.cfg);
        const filtered = nodes
            .sort((a, b) => (pprScores.get(b.id) || 0) - (pprScores.get(a.id) || 0) ||
            b.updatedAt - a.updatedAt ||
            b.validatedCount - a.validatedCount)
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
    mergeResults(precise, generalized) {
        return Recaller.mergeResultsImpl(precise, generalized);
    }
    /**
     * 合并多个独立召回结果：去重节点，保留两端都在最终节点集中的边。
     *
     * 典型的调用方不需要在两条路径之间分配额——各自独立跑满，
     * 合并后再统一去重。对于超过两个结果集的场景使用 {@link mergeMany}。
     */
    static merge(a, b) {
        return Recaller.mergeResultsImpl(a, b);
    }
    /**
     * 合并任意数量的独立召回结果。
     */
    static mergeMany(results) {
        if (!results.length)
            return { nodes: [], edges: [], tokenEstimate: 0 };
        let merged = results[0];
        for (let i = 1; i < results.length; i++) {
            merged = Recaller.mergeResultsImpl(merged, results[i]);
        }
        return merged;
    }
    static mergeResultsImpl(a, b) {
        const nodeMap = new Map();
        const edgeMap = new Map();
        for (const n of a.nodes)
            nodeMap.set(n.id, n);
        for (const e of a.edges)
            edgeMap.set(e.id, e);
        for (const n of b.nodes) {
            if (!nodeMap.has(n.id))
                nodeMap.set(n.id, n);
        }
        const finalIds = new Set(nodeMap.keys());
        for (const e of b.edges) {
            if (!edgeMap.has(e.id) && finalIds.has(e.fromId) && finalIds.has(e.toId)) {
                edgeMap.set(e.id, e);
            }
        }
        const nodes = Array.from(nodeMap.values());
        const edges = Array.from(edgeMap.values());
        return {
            nodes,
            edges,
            tokenEstimate: Math.ceil(nodes.reduce((s, n) => s + n.content.length + n.description.length, 0) / 3),
        };
    }
    /**
     * 多查询召回：对每个查询独立跑路径，并行执行，合并去重。
     *
     * 适用于需要从多个语义角度检索图谱的场景（例如用户消息 + 任务描述）。
     * 每条查询独立跑精确路径 + 泛化路径，互不干扰。
     */
    async recallMulti(queries, options = {}) {
        if (!queries.length)
            return { nodes: [], edges: [], tokenEstimate: 0 };
        const results = await Promise.all(queries.map(q => this.recall(q, options)));
        return Recaller.mergeMany(results);
    }
    estimateTokens(nodes) {
        return Math.ceil(nodes.reduce((s, n) => s + n.content.length + n.description.length, 0) / 3);
    }
    /** 异步同步 embedding，不阻塞主流程 */
    async syncEmbed(node) {
        if (!this.embed)
            return;
        const text = `${node.name}: ${node.description}\n${node.content}`;
        const hashInput = this.embeddingFingerprint ? `${this.embeddingFingerprint}\0${text}` : text;
        const hash = createHash("md5").update(hashInput).digest("hex");
        if (getVectorHash(this.db, node.id) === hash)
            return;
        try {
            const vec = await this.embed(text, "db");
            if (vec.length)
                saveVector(this.db, node.id, hashInput, vec);
        }
        catch { /* 不影响主流程 */ }
    }
}
