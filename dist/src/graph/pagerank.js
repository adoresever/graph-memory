/**
 * graph-memory — Personalized PageRank (PPR)
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 *
 * ═══════════════════════════════════════════════════════════════
 * 个性化 PageRank（Personalized PageRank）
 *
 * 区别于全局 PageRank：
 *   全局 PR：所有节点均匀起步，算一个固定的全局排名
 *   个性化 PPR：从用户查询命中的种子节点出发，沿边传播权重
 *              离种子越近的节点分数越高
 *
 * 同一个图谱：
 *   问 "Docker 部署"   → Docker 相关 SKILL 分数最高
 *   问 "conda 环境"    → conda 相关 SKILL 分数最高
 *   问 "bilibili 爬虫" → bilibili 相关 TASK/SKILL 分数最高
 *
 * 计算时机：
 *   recall 时实时算（不存数据库），每次查询都是新鲜的
 *   O(iterations * edges)，几千节点 < 5ms
 *
 * 另外保留一个全局 PageRank 作为基线，用于：
 *   - topNodes 兜底（没有种子时）
 *   - session_end 时写入 gm_nodes.pagerank 列
 * ═══════════════════════════════════════════════════════════════
 */
import { updatePageranks } from "../store/store.js";
// Cache by concrete SQLite connection. A process can host multiple DSH
// profiles/tests, and graph data from one database must never leak to another.
let _graphCache = new WeakMap();
let _navigationGraphCache = new WeakMap();
/**
 * 读取图结构（按数据库连接缓存）。写入方在事务成功后显式失效，
 * 因而查询不会依赖时间窗口或读取另一 profile 的图。
 */
function loadGraph(db) {
    const cached = _graphCache.get(db);
    if (cached)
        return cached;
    const nodeRows = db.prepare("SELECT id FROM gm_nodes WHERE status='active'").all();
    const nodeIds = new Set(nodeRows.map((r) => r.id));
    const edgeRows = db.prepare("SELECT from_id, to_id FROM gm_edges").all();
    const adj = new Map();
    for (const id of nodeIds)
        adj.set(id, []);
    for (const e of edgeRows) {
        if (!nodeIds.has(e.from_id) || !nodeIds.has(e.to_id))
            continue;
        adj.get(e.from_id).push(e.to_id);
        adj.get(e.to_id).push(e.from_id);
    }
    const graph = { nodeIds, adj, N: nodeIds.size };
    _graphCache.set(db, graph);
    return graph;
}
/** 图结构变化后清除缓存。 */
export function invalidateGraphCache(db) {
    if (db) {
        _graphCache.delete(db);
        _navigationGraphCache.delete(db);
        return;
    }
    _graphCache = new WeakMap();
    _navigationGraphCache = new WeakMap();
}
/** Load the summary-derived SPO navigation graph through the same cache. */
function loadNavigationGraph(db) {
    const cached = _navigationGraphCache.get(db);
    if (cached)
        return cached;
    const nodeRows = db.prepare("SELECT id FROM gm_navigation_terms ORDER BY id").all();
    const nodeIds = new Set(nodeRows.map(row => String(row.id)));
    const edgeRows = db.prepare("SELECT subject_id AS from_id, object_id AS to_id FROM gm_navigation_triples").all();
    const adj = new Map();
    for (const id of nodeIds)
        adj.set(id, []);
    for (const edge of edgeRows) {
        const from = String(edge.from_id);
        const to = String(edge.to_id);
        if (!nodeIds.has(from) || !nodeIds.has(to))
            continue;
        // Repeated evidence intentionally contributes another edge occurrence.
        // This lets recurring dialogue relations carry more navigational weight
        // without inventing a model-derived confidence score.
        adj.get(from).push(to);
        adj.get(to).push(from);
    }
    const graph = { nodeIds, adj, N: nodeIds.size };
    _navigationGraphCache.set(db, graph);
    return graph;
}
function personalizedRank(graph, seedIds, cfg, seedWeights) {
    const { nodeIds, adj, N } = graph;
    if (N === 0 || seedIds.length === 0)
        return new Map();
    const validSeeds = Array.from(new Set(seedIds.filter(id => nodeIds.has(id))));
    if (!validSeeds.length)
        return new Map();
    const rawWeights = validSeeds.map(id => Math.max(0, seedWeights?.get(id) ?? 1));
    const providedTotal = rawWeights.reduce((sum, value) => sum + value, 0);
    const teleport = new Map(validSeeds.map((id, index) => [
        id,
        providedTotal > 0 ? rawWeights[index] / providedTotal : 1 / validSeeds.length,
    ]));
    let rank = new Map();
    for (const id of nodeIds)
        rank.set(id, teleport.get(id) ?? 0);
    for (let iteration = 0; iteration < cfg.pagerankIterations; iteration += 1) {
        const next = new Map();
        for (const id of nodeIds) {
            next.set(id, (1 - cfg.pagerankDamping) * (teleport.get(id) ?? 0));
        }
        let dangling = 0;
        for (const [nodeId, neighbors] of adj) {
            const score = rank.get(nodeId) ?? 0;
            if (!neighbors.length) {
                dangling += score;
                continue;
            }
            const contribution = cfg.pagerankDamping * score / neighbors.length;
            for (const neighbor of neighbors) {
                next.set(neighbor, (next.get(neighbor) ?? 0) + contribution);
            }
        }
        if (dangling > 0) {
            for (const seed of validSeeds) {
                next.set(seed, (next.get(seed) ?? 0) + cfg.pagerankDamping * dangling * (teleport.get(seed) ?? 0));
            }
        }
        rank = next;
    }
    return rank;
}
/**
 * 个性化 PageRank
 *
 * 从 seedIds 出发传播权重：
 *   - teleport 概率 (1-damping) 总是回到种子节点（不是均匀回到所有节点）
 *   - 这样种子附近的节点天然获得更高分数
 *
 * @param seedIds  用户查询命中的种子节点（FTS5/向量搜索结果）
 * @param candidateIds  需要排序的候选节点（图遍历结果）
 * @returns 候选节点的个性化分数
 */
export function personalizedPageRank(db, seedIds, candidateIds, cfg, seedWeights) {
    const graph = loadGraph(db);
    const rank = personalizedRank(graph, seedIds, cfg, seedWeights);
    if (!rank.size)
        return { scores: new Map() };
    // 只返回候选节点的分数
    const result = new Map();
    for (const id of candidateIds) {
        result.set(id, rank.get(id) || 0);
    }
    return { scores: result };
}
/** Query-time PPR over the compact summary-derived SPO navigation graph. */
export function personalizedNavigationPageRank(db, seedIds, candidateIds, cfg, seedWeights) {
    const rank = personalizedRank(loadNavigationGraph(db), seedIds, cfg, seedWeights);
    if (!rank.size)
        return { scores: new Map() };
    const scores = new Map();
    for (const id of candidateIds)
        scores.set(id, rank.get(id) ?? 0);
    return { scores };
}
/**
 * 全局 PageRank — 写入 gm_nodes.pagerank 作为基线
 *
 * 用途：
 *   - topNodes 兜底排序（没有查询种子时的 fallback）
 *   - gm_stats 展示全局重要节点
 *
 * 只在 session_end / gm_maintain 时调用
 */
export function computeGlobalPageRank(db, cfg) {
    const graph = loadGraph(db);
    const { nodeIds, adj, N } = graph;
    const damping = cfg.pagerankDamping;
    const iterations = cfg.pagerankIterations;
    if (N === 0)
        return { scores: new Map(), topK: [] };
    const nameRows = db.prepare("SELECT id, name FROM gm_nodes WHERE status='active'").all();
    const nameMap = new Map();
    nameRows.forEach(r => nameMap.set(r.id, r.name));
    // 全局：均匀 teleport
    let rank = new Map();
    const init = 1 / N;
    for (const id of nodeIds)
        rank.set(id, init);
    for (let i = 0; i < iterations; i++) {
        const newRank = new Map();
        const base = (1 - damping) / N;
        for (const id of nodeIds)
            newRank.set(id, base);
        for (const [nodeId, neighbors] of adj) {
            if (neighbors.length === 0)
                continue;
            const contrib = (rank.get(nodeId) || 0) / neighbors.length;
            for (const nb of neighbors) {
                newRank.set(nb, (newRank.get(nb) || base) + damping * contrib);
            }
        }
        let danglingSum = 0;
        for (const id of nodeIds) {
            const neighbors = adj.get(id);
            if (!neighbors || neighbors.length === 0)
                danglingSum += rank.get(id) || 0;
        }
        if (danglingSum > 0) {
            const dc = damping * danglingSum / N;
            for (const id of nodeIds)
                newRank.set(id, (newRank.get(id) || 0) + dc);
        }
        rank = newRank;
    }
    // 写入数据库
    updatePageranks(db, rank);
    const sorted = Array.from(rank.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([id, score]) => ({ id, name: nameMap.get(id) || id, score }));
    return { scores: rank, topK: sorted };
}
