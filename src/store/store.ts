/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import { createHash, randomUUID } from "crypto";
import type { GmNode, GmEdge, EdgeType, NodeType, Signal } from "../types.ts";

// ─── 工具 ─────────────────────────────────────────────────────

function uid(p: string): string {
  return `${p}-${randomUUID()}`;
}

function toNode(r: any): GmNode {
  return {
    id: r.id, type: r.type, name: r.name,
    description: r.description ?? "", content: r.content,
    status: r.status, validatedCount: r.validated_count,
    sourceSessions: JSON.parse(r.source_sessions ?? "[]"),
    communityId: r.community_id ?? null,
    pagerank: r.pagerank ?? 0,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function toEdge(r: any): GmEdge {
  return {
    id: r.id, fromId: r.from_id, toId: r.to_id, type: r.type,
    instruction: r.instruction, condition: r.condition ?? undefined,
    sessionId: r.session_id, createdAt: r.created_at,
  };
}

/** 标准化 name：全小写，空格转连字符，保留中文 */
function normalizeName(name: string): string {
  return name.trim().toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff\-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

// ─── 节点 CRUD ───────────────────────────────────────────────

export function findByName(db: DatabaseSyncInstance, name: string): GmNode | null {
  const r = db.prepare("SELECT * FROM gm_nodes WHERE name = ?").get(normalizeName(name)) as any;
  return r ? toNode(r) : null;
}

export function findById(db: DatabaseSyncInstance, id: string): GmNode | null {
  const r = db.prepare("SELECT * FROM gm_nodes WHERE id = ?").get(id) as any;
  return r ? toNode(r) : null;
}

export function allActiveNodes(db: DatabaseSyncInstance): GmNode[] {
  return (db.prepare("SELECT * FROM gm_nodes WHERE status='active'").all() as any[]).map(toNode);
}

export function allEdges(db: DatabaseSyncInstance): GmEdge[] {
  return (db.prepare("SELECT * FROM gm_edges").all() as any[]).map(toEdge);
}

export function upsertNode(
  db: DatabaseSyncInstance,
  c: { type: NodeType; name: string; description: string; content: string },
  sessionId: string,
): { node: GmNode; isNew: boolean } {
  const name = normalizeName(c.name);
  const ex = findByName(db, name);

  if (ex) {
    const sessions = JSON.stringify(Array.from(new Set([...ex.sourceSessions, sessionId])));
    const content = c.content.length > ex.content.length ? c.content : ex.content;
    const desc = c.description.length > ex.description.length ? c.description : ex.description;
    const count = ex.validatedCount + 1;
    db.prepare(`UPDATE gm_nodes SET content=?, description=?, validated_count=?,
      source_sessions=?, updated_at=? WHERE id=?`)
      .run(content, desc, count, sessions, Date.now(), ex.id);
    return { node: { ...ex, content, description: desc, validatedCount: count }, isNew: false };
  }

  const id = uid("n");
  db.prepare(`INSERT INTO gm_nodes
    (id, type, name, description, content, status, validated_count, source_sessions, created_at, updated_at)
    VALUES (?,?,?,?,?,'active',1,?,?,?)`)
    .run(id, c.type, name, c.description, c.content, JSON.stringify([sessionId]), Date.now(), Date.now());
  return { node: findByName(db, name)!, isNew: true };
}

export function deprecate(db: DatabaseSyncInstance, nodeId: string): void {
  db.prepare("UPDATE gm_nodes SET status='deprecated', updated_at=? WHERE id=?")
    .run(Date.now(), nodeId);
}

/** 合并两个节点：keepId 保留，mergeId 标记 deprecated，边迁移 */
export function mergeNodes(db: DatabaseSyncInstance, keepId: string, mergeId: string): void {
  const keep = findById(db, keepId);
  const merge = findById(db, mergeId);
  if (!keep || !merge) return;

  // 合并 validatedCount + sourceSessions
  const sessions = JSON.stringify(
    Array.from(new Set([...keep.sourceSessions, ...merge.sourceSessions]))
  );
  const count = keep.validatedCount + merge.validatedCount;
  const content = keep.content.length >= merge.content.length ? keep.content : merge.content;
  const desc = keep.description.length >= merge.description.length ? keep.description : merge.description;

  db.prepare(`UPDATE gm_nodes SET content=?, description=?, validated_count=?,
    source_sessions=?, updated_at=? WHERE id=?`)
    .run(content, desc, count, sessions, Date.now(), keepId);

  // 迁移边：mergeId 的边指向 keepId
  db.prepare("UPDATE gm_edges SET from_id=? WHERE from_id=?").run(keepId, mergeId);
  db.prepare("UPDATE gm_edges SET to_id=? WHERE to_id=?").run(keepId, mergeId);

  // 删除自环（合并后可能出现 keepId → keepId）
  db.prepare("DELETE FROM gm_edges WHERE from_id = to_id").run();

  // 删除重复边（同 from+to+type 只保留一条）
  db.prepare(`
    DELETE FROM gm_edges WHERE id NOT IN (
      SELECT MIN(id) FROM gm_edges GROUP BY from_id, to_id, type
    )
  `).run();

  deprecate(db, mergeId);
}

/** 批量更新 PageRank 分数 */
export function updatePageranks(db: DatabaseSyncInstance, scores: Map<string, number>): void {
  const stmt = db.prepare("UPDATE gm_nodes SET pagerank=? WHERE id=?");
  db.exec("BEGIN");
  try {
    for (const [id, score] of scores) {
      stmt.run(score, id);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** 批量更新社区 ID */
export function updateCommunities(db: DatabaseSyncInstance, labels: Map<string, string>): void {
  const stmt = db.prepare("UPDATE gm_nodes SET community_id=? WHERE id=?");
  db.exec("BEGIN");
  try {
    for (const [id, cid] of labels) {
      stmt.run(cid, id);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ─── 边 CRUD ─────────────────────────────────────────────────

export function upsertEdge(
  db: DatabaseSyncInstance,
  e: { fromId: string; toId: string; type: EdgeType; instruction: string; condition?: string; sessionId: string },
): void {
  const ex = db.prepare("SELECT id FROM gm_edges WHERE from_id=? AND to_id=? AND type=?")
    .get(e.fromId, e.toId, e.type) as any;
  if (ex) {
    db.prepare("UPDATE gm_edges SET instruction=? WHERE id=?")
      .run(e.instruction, ex.id);
    return;
  }
  db.prepare(`INSERT INTO gm_edges (id, from_id, to_id, type, instruction, condition, session_id, created_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(uid("e"), e.fromId, e.toId, e.type, e.instruction, e.condition ?? null, e.sessionId, Date.now());
}

export function edgesFrom(db: DatabaseSyncInstance, id: string): GmEdge[] {
  return (db.prepare("SELECT * FROM gm_edges WHERE from_id=?").all(id) as any[]).map(toEdge);
}

export function edgesTo(db: DatabaseSyncInstance, id: string): GmEdge[] {
  return (db.prepare("SELECT * FROM gm_edges WHERE to_id=?").all(id) as any[]).map(toEdge);
}

// ─── FTS5 搜索 ───────────────────────────────────────────────

const _fts5Cache = new WeakMap<DatabaseSyncInstance, boolean>();

function fts5Available(db: DatabaseSyncInstance): boolean {
  const cached = _fts5Cache.get(db);
  if (cached !== undefined) return cached;
  let result: boolean;
  try {
    db.prepare("SELECT * FROM gm_nodes_fts LIMIT 0").all();
    result = true;
  } catch {
    result = false;
  }
  _fts5Cache.set(db, result);
  return result;
}

export function searchNodes(db: DatabaseSyncInstance, query: string, limit = 6): GmNode[] {
  const terms = query.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!terms.length) return topNodes(db, limit);

  if (fts5Available(db)) {
    try {
      const ftsQuery = terms.map(t => `"${t.replace(/"/g, "")}"`).join(" OR ");
      const rows = db.prepare(`
        SELECT n.*, rank FROM gm_nodes_fts fts
        JOIN gm_nodes n ON n.rowid = fts.rowid
        WHERE gm_nodes_fts MATCH ? AND n.status = 'active'
        ORDER BY rank LIMIT ?
      `).all(ftsQuery, limit) as any[];
      if (rows.length > 0) return rows.map(toNode);
    } catch { /* FTS 查询失败，降级 */ }
  }

  const where = terms.map(() => "(name LIKE ? OR description LIKE ? OR content LIKE ?)").join(" OR ");
  const likes = terms.flatMap(t => [`%${t}%`, `%${t}%`, `%${t}%`]);
  return (db.prepare(`
    SELECT * FROM gm_nodes WHERE status='active' AND (${where})
    ORDER BY pagerank DESC, validated_count DESC, updated_at DESC LIMIT ?
  `).all(...likes, limit) as any[]).map(toNode);
}

/** 热门节点：综合 pagerank + validatedCount 排序 */
export function topNodes(db: DatabaseSyncInstance, limit = 6): GmNode[] {
  return (db.prepare(`
    SELECT * FROM gm_nodes WHERE status='active'
    ORDER BY pagerank DESC, validated_count DESC, updated_at DESC LIMIT ?
  `).all(limit) as any[]).map(toNode);
}

// ─── 递归 CTE 图遍历 ────────────────────────────────────────

export function graphWalk(
  db: DatabaseSyncInstance,
  seedIds: string[],
  maxDepth: number,
): { nodes: GmNode[]; edges: GmEdge[] } {
  if (!seedIds.length) return { nodes: [], edges: [] };

  const placeholders = seedIds.map(() => "?").join(",");

  const walkRows = db.prepare(`
    WITH RECURSIVE walk(node_id, depth) AS (
      SELECT id, 0 FROM gm_nodes WHERE id IN (${placeholders}) AND status='active'
      UNION
      SELECT
        CASE WHEN e.from_id = w.node_id THEN e.to_id ELSE e.from_id END,
        w.depth + 1
      FROM walk w
      JOIN gm_edges e ON (e.from_id = w.node_id OR e.to_id = w.node_id)
      WHERE w.depth < ?
    )
    SELECT DISTINCT node_id FROM walk
  `).all(...seedIds, maxDepth) as any[];

  const nodeIds = walkRows.map((r: any) => r.node_id);
  if (!nodeIds.length) return { nodes: [], edges: [] };

  const np = nodeIds.map(() => "?").join(",");
  const nodes = (db.prepare(`
    SELECT * FROM gm_nodes WHERE id IN (${np}) AND status='active'
  `).all(...nodeIds) as any[]).map(toNode);

  const edges = (db.prepare(`
    SELECT * FROM gm_edges WHERE from_id IN (${np}) AND to_id IN (${np})
  `).all(...nodeIds, ...nodeIds) as any[]).map(toEdge);

  return { nodes, edges };
}

// ─── 按 session 查询 ────────────────────────────────────────

export function getBySession(db: DatabaseSyncInstance, sessionId: string): GmNode[] {
  return (db.prepare(`
    SELECT DISTINCT n.* FROM gm_nodes n, json_each(n.source_sessions) j
    WHERE j.value = ? AND n.status = 'active'
  `).all(sessionId) as any[]).map(toNode);
}

// ─── 消息 CRUD ───────────────────────────────────────────────

export function saveMessage(
  db: DatabaseSyncInstance, sid: string, turn: number, role: string, content: unknown
): void {
  db.prepare(`INSERT OR IGNORE INTO gm_messages (id, session_id, turn_index, role, content, created_at)
    VALUES (?,?,?,?,?,?)`)
    .run(uid("m"), sid, turn, role, JSON.stringify(content), Date.now());
}

export function getMessages(db: DatabaseSyncInstance, sid: string, limit?: number): any[] {
  if (limit) {
    return db.prepare("SELECT * FROM gm_messages WHERE session_id=? ORDER BY turn_index DESC LIMIT ?")
      .all(sid, limit) as any[];
  }
  return db.prepare("SELECT * FROM gm_messages WHERE session_id=? ORDER BY turn_index")
    .all(sid) as any[];
}

export function getUnextracted(db: DatabaseSyncInstance, sid: string, limit: number): any[] {
  return db.prepare("SELECT * FROM gm_messages WHERE session_id=? AND extracted=0 ORDER BY turn_index LIMIT ?")
    .all(sid, limit) as any[];
}

export function markExtracted(db: DatabaseSyncInstance, sid: string, upToTurn: number): void {
  db.prepare("UPDATE gm_messages SET extracted=1 WHERE session_id=? AND turn_index<=?")
    .run(sid, upToTurn);
}

/**
 * 溯源选拉：按 session 拉取 user/assistant 核心对话（跳过 tool/toolResult）
 * 用于 assemble 时补充三元组的原始上下文
 *
 * @param nearTime  优先取时间最接近的消息（节点的 updatedAt）
 * @param maxChars  总字符上限
 */
export function getEpisodicMessages(
  db: DatabaseSyncInstance,
  sessionIds: string[],
  nearTime: number,
  maxChars: number = 1500,
): Array<{ sessionId: string; turnIndex: number; role: string; text: string; createdAt: number }> {
  if (!sessionIds.length) return [];

  const results: Array<{ sessionId: string; turnIndex: number; role: string; text: string; createdAt: number }> = [];
  let usedChars = 0;

  // 按 session 逐个拉，优先最近的 session
  for (const sid of sessionIds) {
    if (usedChars >= maxChars) break;

    // 只拉 user 和 assistant，按时间距离 nearTime 最近排序
    const rows = db.prepare(`
      SELECT turn_index, role, content, created_at FROM gm_messages
      WHERE session_id = ? AND role IN ('user', 'assistant')
      ORDER BY ABS(created_at - ?) ASC
      LIMIT 6
    `).all(sid, nearTime) as any[];

    for (const r of rows) {
      if (usedChars >= maxChars) break;
      let text = "";
      try {
        const parsed = JSON.parse(r.content);
        if (typeof parsed === "string") {
          text = parsed;
        } else if (typeof parsed?.content === "string") {
          text = parsed.content;
        } else if (Array.isArray(parsed)) {
          text = parsed
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text ?? "")
            .join("\n");
        } else {
          text = String(parsed).slice(0, 300);
        }
      } catch {
        text = String(r.content).slice(0, 300);
      }

      if (!text.trim()) continue;
      const truncated = text.slice(0, Math.min(text.length, maxChars - usedChars));
      results.push({
        sessionId: sid,
        turnIndex: r.turn_index,
        role: r.role,
        text: truncated,
        createdAt: r.created_at,
      });
      usedChars += truncated.length;
    }
  }

  return results;
}

// ─── 信号 CRUD ───────────────────────────────────────────────

export function saveSignal(db: DatabaseSyncInstance, sid: string, s: Signal): void {
  db.prepare(`INSERT INTO gm_signals (id, session_id, turn_index, type, data, created_at)
    VALUES (?,?,?,?,?,?)`)
    .run(uid("s"), sid, s.turnIndex, s.type, JSON.stringify(s.data), Date.now());
}

export function pendingSignals(db: DatabaseSyncInstance, sid: string): Signal[] {
  return (db.prepare("SELECT * FROM gm_signals WHERE session_id=? AND processed=0 ORDER BY turn_index")
    .all(sid) as any[])
    .map(r => ({ type: r.type, turnIndex: r.turn_index, data: JSON.parse(r.data) }));
}

export function markSignalsDone(db: DatabaseSyncInstance, sid: string): void {
  db.prepare("UPDATE gm_signals SET processed=1 WHERE session_id=?").run(sid);
}

// ─── 统计 ────────────────────────────────────────────────────

export function getStats(db: DatabaseSyncInstance): {
  totalNodes: number;
  byType: Record<string, number>;
  totalEdges: number;
  byEdgeType: Record<string, number>;
  communities: number;
} {
  const totalNodes = (db.prepare("SELECT COUNT(*) as c FROM gm_nodes WHERE status='active'").get() as any).c;
  const byType: Record<string, number> = {};
  for (const r of db.prepare("SELECT type, COUNT(*) as c FROM gm_nodes WHERE status='active' GROUP BY type").all() as any[]) {
    byType[r.type] = r.c;
  }
  const totalEdges = (db.prepare("SELECT COUNT(*) as c FROM gm_edges").get() as any).c;
  const byEdgeType: Record<string, number> = {};
  for (const r of db.prepare("SELECT type, COUNT(*) as c FROM gm_edges GROUP BY type").all() as any[]) {
    byEdgeType[r.type] = r.c;
  }
  const communities = (db.prepare(
    "SELECT COUNT(DISTINCT community_id) as c FROM gm_nodes WHERE status='active' AND community_id IS NOT NULL"
  ).get() as any).c;
  return { totalNodes, byType, totalEdges, byEdgeType, communities };
}

// ─── 向量存储 + 搜索 ────────────────────────────────────────

export function saveVector(db: DatabaseSyncInstance, nodeId: string, content: string, vec: number[]): void {
  const hash = createHash("md5").update(content).digest("hex");
  const f32 = new Float32Array(vec);
  const blob = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  db.prepare(`INSERT INTO gm_vectors (node_id, content_hash, embedding) VALUES (?,?,?)
    ON CONFLICT(node_id) DO UPDATE SET content_hash=excluded.content_hash, embedding=excluded.embedding`)
    .run(nodeId, hash, blob);
}

export function getVectorHash(db: DatabaseSyncInstance, nodeId: string): string | null {
  return (db.prepare("SELECT content_hash FROM gm_vectors WHERE node_id=?").get(nodeId) as any)?.content_hash ?? null;
}

/** 获取所有向量（供去重/聚类用） */
export function getAllVectors(db: DatabaseSyncInstance): Array<{ nodeId: string; embedding: Float32Array }> {
  const rows = db.prepare(`
    SELECT v.node_id, v.embedding FROM gm_vectors v
    JOIN gm_nodes n ON n.id = v.node_id WHERE n.status = 'active'
  `).all() as any[];
  return rows.map(r => {
    const raw = r.embedding as Uint8Array;
    return {
      nodeId: r.node_id,
      embedding: new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4),
    };
  });
}

export type ScoredNode = { node: GmNode; score: number };

export function vectorSearchWithScore(db: DatabaseSyncInstance, queryVec: number[], limit: number, minScore = 0.35): ScoredNode[] {
  const rows = db.prepare(`
    SELECT v.node_id, v.embedding, n.*
    FROM gm_vectors v JOIN gm_nodes n ON n.id = v.node_id
    WHERE n.status = 'active'
  `).all() as any[];

  if (!rows.length) return [];

  const q = new Float32Array(queryVec);
  const qNorm = Math.sqrt(q.reduce((s, x) => s + x * x, 0));
  if (qNorm === 0) return [];

  return rows
    .map(row => {
      const raw = row.embedding as Uint8Array;
      const v = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
      let dot = 0, vNorm = 0;
      const len = Math.min(v.length, q.length);
      for (let i = 0; i < len; i++) {
        dot += v[i] * q[i];
        vNorm += v[i] * v[i];
      }
      return { score: dot / (Math.sqrt(vNorm) * qNorm + 1e-9), node: toNode(row) };
    })
    .filter(s => s.score > minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** 兼容旧接口 */
export function vectorSearch(db: DatabaseSyncInstance, queryVec: number[], limit: number, minScore = 0.35): GmNode[] {
  return vectorSearchWithScore(db, queryVec, limit, minScore).map(s => s.node);
}

/**
 * 社区代表节点：每个社区取最近更新的 topN 个节点
 * 用于泛化召回 —— 用户问"做了哪些工作"时按领域返回概览
 */
export function communityRepresentatives(db: DatabaseSyncInstance, perCommunity = 2): GmNode[] {
  const rows = db.prepare(`
    SELECT * FROM gm_nodes
    WHERE status = 'active' AND community_id IS NOT NULL
    ORDER BY community_id, updated_at DESC
  `).all() as any[];

  const byCommunity = new Map<string, GmNode[]>();
  for (const r of rows) {
    const node = toNode(r);
    const cid = r.community_id as string;
    if (!byCommunity.has(cid)) byCommunity.set(cid, []);
    const list = byCommunity.get(cid)!;
    if (list.length < perCommunity) list.push(node);
  }

  // 社区按最新更新时间排序
  const communities = Array.from(byCommunity.entries())
    .sort((a, b) => {
      const aTime = Math.max(...a[1].map(n => n.updatedAt));
      const bTime = Math.max(...b[1].map(n => n.updatedAt));
      return bTime - aTime;
    });

  const result: GmNode[] = [];
  for (const [, nodes] of communities) {
    result.push(...nodes);
  }
  return result;
}

// ─── 社区描述 CRUD ──────────────────────────────────────────

export interface CommunitySummary {
  id: string;
  summary: string;
  nodeCount: number;
  createdAt: number;
  updatedAt: number;
}

export function upsertCommunitySummary(
  db: DatabaseSyncInstance, id: string, summary: string, nodeCount: number, embedding?: number[],
): void {
  const now = Date.now();
  const blob = embedding ? new Uint8Array(new Float32Array(embedding).buffer) : null;
  const ex = db.prepare("SELECT id FROM gm_communities WHERE id=?").get(id) as any;
  if (ex) {
    if (blob) {
      db.prepare("UPDATE gm_communities SET summary=?, node_count=?, embedding=?, updated_at=? WHERE id=?")
        .run(summary, nodeCount, blob, now, id);
    } else {
      db.prepare("UPDATE gm_communities SET summary=?, node_count=?, updated_at=? WHERE id=?")
        .run(summary, nodeCount, now, id);
    }
  } else {
    db.prepare("INSERT INTO gm_communities (id, summary, node_count, embedding, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .run(id, summary, nodeCount, blob, now, now);
  }
}

export function getCommunitySummary(db: DatabaseSyncInstance, id: string): CommunitySummary | null {
  const r = db.prepare("SELECT * FROM gm_communities WHERE id=?").get(id) as any;
  if (!r) return null;
  return { id: r.id, summary: r.summary, nodeCount: r.node_count, createdAt: r.created_at, updatedAt: r.updated_at };
}

export function getAllCommunitySummaries(db: DatabaseSyncInstance): CommunitySummary[] {
  return (db.prepare("SELECT * FROM gm_communities ORDER BY node_count DESC").all() as any[])
    .map(r => ({ id: r.id, summary: r.summary, nodeCount: r.node_count, createdAt: r.created_at, updatedAt: r.updated_at }));
}

export type ScoredCommunity = { id: string; summary: string; score: number; nodeCount: number };

/**
 * 社区向量搜索：用 query 向量匹配社区 embedding，返回按相似度排序的社区
 */
export function communityVectorSearch(db: DatabaseSyncInstance, queryVec: number[], minScore = 0.15): ScoredCommunity[] {
  const rows = db.prepare(
    "SELECT id, summary, node_count, embedding FROM gm_communities WHERE embedding IS NOT NULL"
  ).all() as any[];

  if (!rows.length) return [];

  const q = new Float32Array(queryVec);
  const qNorm = Math.sqrt(q.reduce((s, x) => s + x * x, 0));
  if (qNorm === 0) return [];

  return rows
    .map(r => {
      const raw = r.embedding as Uint8Array;
      const v = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
      let dot = 0, vNorm = 0;
      const len = Math.min(v.length, q.length);
      for (let i = 0; i < len; i++) {
        dot += v[i] * q[i];
        vNorm += v[i] * v[i];
      }
      return {
        id: r.id as string,
        summary: r.summary as string,
        score: dot / (Math.sqrt(vNorm) * qNorm + 1e-9),
        nodeCount: r.node_count as number,
      };
    })
    .filter(s => s.score > minScore)
    .sort((a, b) => b.score - a.score);
}

/**
 * 按社区 ID 列表获取成员节点（按时间倒序）
 */
export function nodesByCommunityIds(db: DatabaseSyncInstance, communityIds: string[], perCommunity = 3): GmNode[] {
  if (!communityIds.length) return [];
  const placeholders = communityIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT * FROM gm_nodes
    WHERE community_id IN (${placeholders}) AND status='active'
    ORDER BY community_id, updated_at DESC
  `).all(...communityIds) as any[];

  const byCommunity = new Map<string, GmNode[]>();
  for (const r of rows) {
    const node = toNode(r);
    const cid = r.community_id as string;
    if (!byCommunity.has(cid)) byCommunity.set(cid, []);
    const list = byCommunity.get(cid)!;
    if (list.length < perCommunity) list.push(node);
  }

  const result: GmNode[] = [];
  for (const cid of communityIds) {
    const members = byCommunity.get(cid);
    if (members) result.push(...members);
  }
  return result;
}

/** 清除已不存在的社区描述 */
export function pruneCommunitySummaries(db: DatabaseSyncInstance): number {
  const result = db.prepare(`
    DELETE FROM gm_communities WHERE id NOT IN (
      SELECT DISTINCT community_id FROM gm_nodes WHERE community_id IS NOT NULL AND status='active'
    )
  `).run();
  return result.changes;
}