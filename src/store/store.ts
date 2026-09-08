/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

import { DatabaseSync, type DatabaseSyncInstance } from "./sqlite.ts";
import { createHash } from "crypto";
import type {
  GmNode,
  GmEdge,
  GmTurnMemory,
  EdgeType,
  NodeTemporal,
  NodeType,
  TurnOutcome,
} from "../types.ts";

// ─── 工具 ─────────────────────────────────────────────────────

function uid(p: string): string {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function embeddingBlob(vector: number[]): Uint8Array {
  const values = new Float32Array(vector);
  return new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
}

function vectorNorm(vector: Float32Array): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function cosineSimilarity(query: Float32Array, queryNorm: number, raw: Uint8Array): number {
  const vector = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  if (vector.length !== query.length) return Number.NEGATIVE_INFINITY;
  let dot = 0;
  let candidateSquaredNorm = 0;
  for (let index = 0; index < query.length; index += 1) {
    dot += vector[index] * query[index];
    candidateSquaredNorm += vector[index] * vector[index];
  }
  return dot / (Math.sqrt(candidateSquaredNorm) * queryNorm + 1e-9);
}

function toNode(r: any): GmNode {
  return {
    id: r.id, type: r.type, name: r.name,
    description: r.description ?? "", content: r.content,
    temporal: JSON.parse(r.temporal_json ?? "{}"),
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
  c: {
    type: NodeType;
    name: string;
    description: string;
    content: string;
    operation?: "create" | "confirm" | "revise";
    temporal?: NodeTemporal;
  },
  sessionId: string,
  sources: Array<{ messageId: string; turnIndex: number }> = [],
): { node: GmNode; isNew: boolean } {
  const name = normalizeName(c.name);
  const ex = findByName(db, name);

  if (ex) {
    const sessions = JSON.stringify(Array.from(new Set([...ex.sourceSessions, sessionId])));
    // The extractor owns the claim operation.  Content length is not evidence
    // of correctness, so the store must never use it to choose a version.
    // Only an explicit confirmation preserves the current claim; create and
    // revise both publish the model's current structured claim as a revision.
    const replace = c.operation !== "confirm";
    const content = replace ? c.content : ex.content;
    const desc = replace ? c.description : ex.description;
    const temporal = replace
      ? (c.temporal ?? {})
      : c.temporal && Object.keys(c.temporal).length
        ? c.temporal
        : ex.temporal;
    // A correction is a new claim version, not another validation of the old
    // claim. Confirmation alone increases confidence.
    const count = replace ? 1 : ex.validatedCount + 1;
    if (replace) {
      const previousSourceRefs = db.prepare(`
        SELECT session_id, message_id, turn_index
        FROM gm_node_sources WHERE node_id=?
        ORDER BY turn_index, message_id
      `).all(ex.id);
      db.prepare(`INSERT INTO gm_node_revisions
        (node_id, previous_description, previous_content, previous_temporal_json,
         previous_validated_count, previous_source_refs, replacement_session_id, replaced_at)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(
          ex.id,
          ex.description,
          ex.content,
          JSON.stringify(ex.temporal),
          ex.validatedCount,
          JSON.stringify(previousSourceRefs),
          sessionId,
          Date.now(),
        );
      // The active node must cite only evidence for its current claim. Older
      // provenance remains auditable in gm_node_revisions.
      db.prepare("DELETE FROM gm_node_sources WHERE node_id=?").run(ex.id);
    }
    db.prepare(`UPDATE gm_nodes SET content=?, description=?, temporal_json=?, status='active', validated_count=?,
      source_sessions=?, updated_at=? WHERE id=?`)
      .run(content, desc, JSON.stringify(temporal), count, sessions, Date.now(), ex.id);
    saveNodeSources(db, ex.id, sessionId, sources);
    return { node: { ...ex, content, description: desc, temporal, status: "active", validatedCount: count }, isNew: false };
  }

  const id = uid("n");
  db.prepare(`INSERT INTO gm_nodes
    (id, type, name, description, content, temporal_json, status, validated_count, source_sessions, created_at, updated_at)
    VALUES (?,?,?,?,?,?,'active',1,?,?,?)`)
    .run(id, c.type, name, c.description, c.content, JSON.stringify(c.temporal ?? {}), JSON.stringify([sessionId]), Date.now(), Date.now());
  const node = findByName(db, name)!;
  saveNodeSources(db, node.id, sessionId, sources);
  return { node, isNew: true };
}

/** Link one graph node to durable message rows that actually exist. */
export function saveNodeSources(
  db: DatabaseSyncInstance,
  nodeId: string,
  sessionId: string,
  sources: Array<{ messageId: string; turnIndex: number }>,
): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO gm_node_sources (node_id, session_id, message_id, turn_index)
    SELECT ?, ?, id, turn_index FROM gm_messages WHERE id=?
  `);
  for (const source of sources) {
    insert.run(nodeId, sessionId, source.messageId);
  }
}

export interface GmNodeSource {
  nodeId: string;
  sessionId: string;
  messageId: string;
  turnIndex: number;
}

/** Read exact provenance refs without loading or truncating message content. */
export function getNodeSources(
  db: DatabaseSyncInstance,
  nodeIds: string[],
): GmNodeSource[] {
  if (!nodeIds.length) return [];
  const placeholders = nodeIds.map(() => "?").join(",");
  return (db.prepare(`
    SELECT node_id, session_id, message_id, turn_index
    FROM gm_node_sources
    WHERE node_id IN (${placeholders})
    ORDER BY node_id, turn_index, message_id
  `).all(...nodeIds) as any[]).map(row => ({
    nodeId: String(row.node_id),
    sessionId: String(row.session_id),
    messageId: String(row.message_id),
    turnIndex: Number(row.turn_index),
  }));
}

/** 按 name 精确更新 description / content；找不到返回 null（调用方决定报错语义） */
export function updateNode(
  db: DatabaseSyncInstance,
  name: string,
  patch: { description?: string; content?: string },
): GmNode | null {
  const ex = findByName(db, name);
  if (!ex) return null;
  const now = Date.now();
  const description = patch.description ?? ex.description;
  const content = patch.content ?? ex.content;
  db.prepare("UPDATE gm_nodes SET description=?, content=?, updated_at=? WHERE id=?")
    .run(description, content, now, ex.id);
  return { ...ex, description, content, updatedAt: now };
}

export function deprecate(
  db: DatabaseSyncInstance,
  nodeId: string,
  temporalState: "historical" | "superseded" = "historical",
): void {
  const node = findById(db, nodeId);
  if (!node) return;
  const temporal = { ...node.temporal, state: temporalState };
  db.prepare("UPDATE gm_nodes SET status='deprecated', temporal_json=?, updated_at=? WHERE id=?")
    .run(JSON.stringify(temporal), Date.now(), nodeId);
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
    db.prepare("UPDATE gm_edges SET instruction=?, condition=?, session_id=? WHERE id=?")
      .run(e.instruction, e.condition ?? null, e.sessionId, ex.id);
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

// FTS support belongs to a concrete connection. A process-global boolean is
// incorrect when multiple host profiles use different SQLite builds or when
// tests/DSH fibers own independent databases.
const fts5Availability = new WeakMap<object, boolean>();

function fts5Available(db: DatabaseSyncInstance): boolean {
  const cached = fts5Availability.get(db as object);
  if (cached !== undefined) return cached;
  try {
    db.prepare("SELECT * FROM gm_nodes_fts LIMIT 0").all();
    fts5Availability.set(db as object, true);
    return true;
  } catch {
    fts5Availability.set(db as object, false);
    return false;
  }
}

export function searchNodes(
  db: DatabaseSyncInstance,
  query: string,
  limit = 6,
  withoutTurnMemory = false,
): GmNode[] {
  const terms = Array.from(new Set(query.trim().split(/\s+/).filter(Boolean)));
  if (!terms.length) return topNodes(db, limit);

  if (fts5Available(db)) {
    try {
      const ftsQuery = terms.map(t => `"${t.replace(/"/g, "")}"`).join(" OR ");
      const rows = db.prepare(`
        SELECT n.*, rank FROM gm_nodes_fts fts
        JOIN gm_nodes n ON n.rowid = fts.rowid
        WHERE gm_nodes_fts MATCH ? AND n.status = 'active'
          ${withoutTurnMemory ? `AND NOT EXISTS (
            SELECT 1 FROM gm_node_sources node_source
            JOIN gm_turn_memory_sources memory_source
              ON memory_source.message_id=node_source.message_id
            WHERE node_source.node_id=n.id
          )` : ""}
        ORDER BY rank LIMIT ?
      `).all(ftsQuery, limit) as any[];
      if (rows.length > 0) return rows.map(toNode);
    } catch { /* FTS 查询失败，降级 */ }
  }

  const where = terms.map(() => "(name LIKE ? OR description LIKE ? OR content LIKE ?)").join(" OR ");
  const likes = terms.flatMap(t => [`%${t}%`, `%${t}%`, `%${t}%`]);
  return (db.prepare(`
    SELECT * FROM gm_nodes n WHERE status='active' AND (${where})
      ${withoutTurnMemory ? `AND NOT EXISTS (
        SELECT 1 FROM gm_node_sources node_source
        JOIN gm_turn_memory_sources memory_source
          ON memory_source.message_id=node_source.message_id
        WHERE node_source.node_id=n.id
      )` : ""}
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

/**
 * Nodes supported by the current session's recent completed turns.
 * The turn window follows the host's visible-history policy; it is not a
 * second node-count cap and therefore keeps every concept extracted per turn.
 */
export function getRecentBySession(
  db: DatabaseSyncInstance,
  sessionId: string,
  currentTurn: number,
  turnCount: number,
): GmNode[] {
  const firstTurn = Math.max(0, currentTurn - turnCount);
  return (db.prepare(`
    SELECT DISTINCT n.*
    FROM gm_nodes n
    JOIN gm_node_sources s ON s.node_id=n.id
    WHERE n.status='active' AND s.session_id=?
      AND s.turn_index>=? AND s.turn_index<?
    ORDER BY n.updated_at DESC
  `).all(sessionId, firstTurn, currentTurn) as any[]).map(toNode);
}

// ─── 消息 CRUD ───────────────────────────────────────────────

export function saveMessage(
  db: DatabaseSyncInstance, sid: string, turn: number, role: string, content: unknown
): string {
  const id = uid("m");
  db.prepare(`INSERT OR IGNORE INTO gm_messages (id, session_id, turn_index, role, content, created_at)
    VALUES (?,?,?,?,?,?)`)
    .run(id, sid, turn, role, JSON.stringify(content), Date.now());
  return id;
}

/**
 * Persist one host event exactly once.
 *
 * DSH session events already carry a stable, monotonically increasing seq.
 * Host adapters use that identity instead of the legacy random id so replay,
 * resume and HMR backfill cannot duplicate a message.
 */
export function saveMessageOnce(
  db: DatabaseSyncInstance,
  eventId: string,
  sid: string,
  turn: number,
  role: string,
  content: unknown,
): boolean {
  const result = db.prepare(`INSERT OR IGNORE INTO gm_messages
    (id, session_id, turn_index, role, content, created_at)
    VALUES (?,?,?,?,?,?)`)
    .run(eventId, sid, turn, role, JSON.stringify(content), Date.now());
  return result.changes > 0;
}

/**
 * Read the oldest pending completed turn as one semantic extraction job.
 * No character/message batching is involved: the DSH adapter persists exactly
 * one user question and one final assistant answer for each completed turn.
 */
export function getNextUnextractedTurn(
  db: DatabaseSyncInstance,
  sid: string,
  completedTurn: number,
): any[] {
  const next = db.prepare(`
    SELECT MIN(turn_index) AS turn_index
    FROM gm_messages
    WHERE session_id=? AND extracted=0 AND extraction_state='pending'
      AND turn_index<=?
  `).get(sid, completedTurn) as { turn_index?: number | null } | undefined;
  if (next?.turn_index === null || next?.turn_index === undefined) return [];
  return db.prepare(`
    SELECT * FROM gm_messages
    WHERE session_id=? AND turn_index=? AND extracted=0 AND extraction_state='pending'
    ORDER BY rowid
  `).all(sid, Number(next.turn_index)) as any[];
}

/**
 * Read one exact completed turn. Live DSH extraction uses this path so an
 * unrelated legacy backlog can never be pulled into a foreground session.
 * Historical retries deliberately use getNextUnextractedTurn instead.
 */
export function getUnextractedTurn(
  db: DatabaseSyncInstance,
  sid: string,
  turn: number,
): any[] {
  if (!Number.isInteger(turn) || turn < 1) return [];
  return db.prepare(`
    SELECT * FROM gm_messages
    WHERE session_id=? AND turn_index=? AND extracted=0 AND extraction_state='pending'
    ORDER BY rowid
  `).all(sid, turn) as any[];
}

/** Persist the highest DSH/OpenClaw turn known to be complete. */
export function markExtractionTurnCompleted(
  db: DatabaseSyncInstance,
  sid: string,
  completedTurn: number,
): void {
  if (!Number.isFinite(completedTurn)) return;
  db.prepare(`
    INSERT INTO gm_extraction_sessions (session_id, completed_turn, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      completed_turn=MAX(completed_turn, excluded.completed_turn),
      updated_at=excluded.updated_at
  `).run(sid, completedTurn, Date.now());
}

export function getExtractionCompletedTurn(
  db: DatabaseSyncInstance,
  sid: string,
): number | null {
  const row = db.prepare(`
    SELECT completed_turn FROM gm_extraction_sessions WHERE session_id=?
  `).get(sid) as { completed_turn?: number } | undefined;
  return row?.completed_turn === undefined ? null : Number(row.completed_turn);
}

function messageIdPlaceholders(ids: string[]): string {
  return ids.map(() => "?").join(",");
}

/** Mark only the source rows actually accepted by the extractor. */
export function markMessagesExtracted(db: DatabaseSyncInstance, ids: string[]): number {
  if (!ids.length) return 0;
  const result = db.prepare(`
    UPDATE gm_messages
    SET extracted=1, extraction_state='succeeded', extraction_error=NULL,
        extraction_next_retry_at=NULL, extraction_updated_at=?
    WHERE id IN (${messageIdPlaceholders(ids)}) AND extraction_state='pending'
  `).run(Date.now(), ...ids);
  return Number(result.changes);
}

export function recordExtractionFailure(
  db: DatabaseSyncInstance,
  ids: string[],
  error: string,
  nextRetryAt: number | null,
): number {
  if (!ids.length) return 0;
  const result = db.prepare(`
    UPDATE gm_messages
    SET extraction_attempts=extraction_attempts+1, extraction_error=?,
        extraction_next_retry_at=?, extraction_updated_at=?
    WHERE id IN (${messageIdPlaceholders(ids)}) AND extraction_state='pending'
  `).run(error.slice(0, 2_000), nextRetryAt, Date.now(), ...ids);
  return Number(result.changes);
}

/** A poison message remains durable and explicitly unlearned until retried. */
export function quarantineMessages(db: DatabaseSyncInstance, ids: string[], error: string): number {
  if (!ids.length) return 0;
  const result = db.prepare(`
    UPDATE gm_messages
    SET extracted=0, extraction_state='quarantined', extraction_error=?,
        extraction_next_retry_at=NULL, extraction_updated_at=?
    WHERE id IN (${messageIdPlaceholders(ids)}) AND extraction_state='pending'
  `).run(error.slice(0, 2_000), Date.now(), ...ids);
  return Number(result.changes);
}

export function requeueQuarantined(db: DatabaseSyncInstance, sid?: string): number {
  const result = sid
    ? db.prepare(`
        UPDATE gm_messages
        SET extraction_state='pending', extraction_attempts=0, extraction_error=NULL,
            extraction_next_retry_at=NULL, extraction_updated_at=?
        WHERE extraction_state='quarantined' AND session_id=?
      `).run(Date.now(), sid)
    : db.prepare(`
        UPDATE gm_messages
        SET extraction_state='pending', extraction_attempts=0, extraction_error=NULL,
            extraction_next_retry_at=NULL, extraction_updated_at=?
        WHERE extraction_state='quarantined'
      `).run(Date.now());
  return Number(result.changes);
}

export function getExtractionStats(db: DatabaseSyncInstance): {
  pending: number;
  succeeded: number;
  quarantined: number;
} {
  const rows = db.prepare(`
    SELECT extraction_state AS state, COUNT(*) AS count
    FROM gm_messages GROUP BY extraction_state
  `).all() as Array<{ state: string; count: number }>;
  const result = { pending: 0, succeeded: 0, quarantined: 0 };
  for (const row of rows) {
    if (row.state in result) (result as any)[row.state] = Number(row.count);
  }
  return result;
}

export function getPendingSessionIds(db: DatabaseSyncInstance, limit: number = 100): string[] {
  return (db.prepare(`
    SELECT session_id, MIN(turn_index) AS first_turn
    FROM gm_messages
    WHERE extracted=0 AND extraction_state='pending'
      AND (extraction_next_retry_at IS NULL OR extraction_next_retry_at<=?)
    GROUP BY session_id ORDER BY first_turn, session_id LIMIT ?
  `).all(Date.now(), limit) as Array<{ session_id: string }>).map(row => row.session_id);
}

/** Read exact durable message evidence for one node, in source order. */
export function getNodeSourceMessages(
  db: DatabaseSyncInstance,
  nodeId: string,
  excludedMessageIds: ReadonlySet<string> = new Set(),
): Array<{ sessionId: string; turnIndex: number; role: string; text: string; createdAt: number }> {
  const rows = db.prepare(`
    SELECT s.message_id, s.session_id, s.turn_index, m.role, m.content, m.created_at
    FROM gm_node_sources s
    JOIN gm_messages m ON m.id=s.message_id
    WHERE s.node_id=?
    ORDER BY s.turn_index, m.created_at
  `).all(nodeId) as any[];
  const results: Array<{ sessionId: string; turnIndex: number; role: string; text: string; createdAt: number }> = [];
  for (const row of rows) {
    if (excludedMessageIds.has(String(row.message_id))) continue;
    let text = "";
    try {
      text = extractStoredText(JSON.parse(row.content));
    } catch {
      text = String(row.content);
    }
    if (!text.trim()) continue;
    results.push({
      sessionId: row.session_id,
      turnIndex: row.turn_index,
      role: row.role,
      text,
      createdAt: row.created_at,
    });
  }
  return results;
}

/** Read text from legacy OpenClaw payloads and DSH block-based messages. */
export function extractStoredText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractStoredText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") {
    return record.text;
  }
  // Typed non-text blocks are reasoning/tool protocol data, not user-visible
  // evidence. Do not recurse into their payloads.
  if (typeof record.type === "string") return "";
  if (record.content !== undefined) return extractStoredText(record.content);
  if (record.message !== undefined) return extractStoredText(record.message);
  return "";
}

// ─── 分层轮次记忆 ──────────────────────────────────────────

function toTurnMemory(db: DatabaseSyncInstance, row: any): GmTurnMemory {
  const sources = (db.prepare(`
    SELECT message_id, turn_index
    FROM gm_turn_memory_sources
    WHERE memory_id=?
    ORDER BY source_order
  `).all(row.id) as any[]).map(source => ({
    messageId: String(source.message_id),
    turnIndex: Number(source.turn_index),
  }));
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    summary: String(row.summary),
    outcome: row.outcome as TurnOutcome,
    sources,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function turnMemoryId(sessionId: string, sources: Array<{ messageId: string }>): string {
  const sourceKey = sources.map(source => source.messageId).sort().join("\0");
  const digest = createHash("sha256").update(`${sessionId}\0${sourceKey}`).digest("hex");
  return `tm-${digest.slice(0, 32)}`;
}

/** Store one compact index while retaining exact message provenance. */
export function upsertTurnMemory(
  db: DatabaseSyncInstance,
  input: {
    sessionId: string;
    summary: string;
    outcome: TurnOutcome;
    sources: Array<{ messageId: string; turnIndex: number }>;
  },
): GmTurnMemory {
  if (!input.sources.length) throw new Error("turn memory requires at least one durable source message");
  const id = turnMemoryId(input.sessionId, input.sources);
  const now = Date.now();
  db.prepare(`
    INSERT INTO gm_turn_memories (id, session_id, summary, outcome, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      summary=excluded.summary,
      outcome=excluded.outcome,
      updated_at=excluded.updated_at
  `).run(id, input.sessionId, input.summary, input.outcome, now, now);
  const link = db.prepare(`
    INSERT OR IGNORE INTO gm_turn_memory_sources (memory_id, message_id, turn_index, source_order)
    SELECT ?, id, turn_index, ? FROM gm_messages WHERE id=?
  `);
  input.sources.forEach((source, index) => link.run(id, index, source.messageId));
  const row = db.prepare("SELECT * FROM gm_turn_memories WHERE id=?").get(id);
  return toTurnMemory(db, row);
}

export function getTurnMemoriesByIds(
  db: DatabaseSyncInstance,
  ids: string[],
): GmTurnMemory[] {
  const memories: GmTurnMemory[] = [];
  const statement = db.prepare("SELECT * FROM gm_turn_memories WHERE id=?");
  for (const id of ids) {
    const row = statement.get(id);
    if (row) memories.push(toTurnMemory(db, row));
  }
  return memories;
}

export function hasTurnMemories(db: DatabaseSyncInstance): boolean {
  return Number((db.prepare("SELECT COUNT(*) AS count FROM gm_turn_memories").get() as any)?.count ?? 0) > 0;
}

/** Lexical fallback for hosts without a working embedding provider. */
export function searchTurnMemories(
  db: DatabaseSyncInstance,
  query: string,
  limit: number,
): GmTurnMemory[] {
  const phrase = query.trim().replace(/\s+/g, " ");
  if (!phrase) return [];
  // Semantic search handles paraphrases. The lexical fallback deliberately
  // requires the complete phrase; OR-ing common words such as "is"/"the"
  // turns a fallback into another source of unrelated prompt injection.
  const rows = db.prepare(`
    SELECT * FROM gm_turn_memories
    WHERE summary LIKE ?
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(`%${phrase}%`, limit) as any[];
  return rows.map(row => toTurnMemory(db, row));
}

export function saveTurnVector(
  db: DatabaseSyncInstance,
  memoryId: string,
  content: string,
  vec: number[],
): void {
  const hash = createHash("md5").update(content).digest("hex");
  db.prepare(`
    INSERT INTO gm_turn_vectors (memory_id, content_hash, embedding)
    VALUES (?, ?, ?)
    ON CONFLICT(memory_id) DO UPDATE SET
      content_hash=excluded.content_hash,
      embedding=excluded.embedding
  `).run(memoryId, hash, embeddingBlob(vec));
}

export function getTurnVectorHash(db: DatabaseSyncInstance, memoryId: string): string | null {
  return (db.prepare("SELECT content_hash FROM gm_turn_vectors WHERE memory_id=?").get(memoryId) as any)
    ?.content_hash ?? null;
}

export type ScoredTurnMemory = { memory: GmTurnMemory; score: number };

export function turnMemoryVectorSearchWithScore(
  db: DatabaseSyncInstance,
  queryVec: number[],
  limit: number,
  minScore: number,
): ScoredTurnMemory[] {
  const rows = db.prepare(`
    SELECT v.embedding, m.*
    FROM gm_turn_vectors v
    JOIN gm_turn_memories m ON m.id=v.memory_id
  `).all() as any[];
  if (!rows.length) return [];
  const query = new Float32Array(queryVec);
  const queryNorm = vectorNorm(query);
  if (queryNorm === 0) return [];
  return rows.map(row => ({
    memory: toTurnMemory(db, row),
    score: cosineSimilarity(query, queryNorm, row.embedding as Uint8Array),
  })).filter(result => result.score >= minScore)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

/** Resolve graph navigation nodes whose evidence belongs to matched turns. */
export function nodesForTurnMemories(
  db: DatabaseSyncInstance,
  memoryIds: string[],
  limit: number,
): GmNode[] {
  const results: GmNode[] = [];
  const seen = new Set<string>();
  const statement = db.prepare(`
    SELECT DISTINCT n.*
    FROM gm_turn_memory_sources memory_source
    JOIN gm_node_sources node_source ON node_source.message_id=memory_source.message_id
    JOIN gm_nodes n ON n.id=node_source.node_id
    WHERE memory_source.memory_id=? AND n.status='active'
    ORDER BY n.updated_at DESC
  `);
  for (const memoryId of memoryIds) {
    for (const row of statement.all(memoryId) as any[]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      results.push(toNode(row));
      if (results.length >= limit) return results;
    }
  }
  return results;
}

/** Read exact Q/A evidence for matched compact memories. */
export function getTurnMemorySourceMessages(
  db: DatabaseSyncInstance,
  memoryId: string,
  excludedMessageIds: ReadonlySet<string> = new Set(),
): Array<{ sessionId: string; turnIndex: number; role: string; text: string; createdAt: number }> {
  const rows = db.prepare(`
    SELECT m.id, tm.session_id, source.turn_index, m.role, m.content, m.created_at
    FROM gm_turn_memory_sources source
    JOIN gm_turn_memories tm ON tm.id=source.memory_id
    JOIN gm_messages m ON m.id=source.message_id
    WHERE source.memory_id=?
    ORDER BY source.source_order
  `).all(memoryId) as any[];
  return rows.flatMap(row => {
    if (excludedMessageIds.has(String(row.id))) return [];
    let text = "";
    try {
      text = extractStoredText(JSON.parse(row.content));
    } catch {
      text = String(row.content);
    }
    return text.trim() ? [{
      sessionId: String(row.session_id),
      turnIndex: Number(row.turn_index),
      role: String(row.role),
      text,
      createdAt: Number(row.created_at),
    }] : [];
  });
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
  db.prepare(`INSERT INTO gm_vectors (node_id, content_hash, embedding) VALUES (?,?,?)
    ON CONFLICT(node_id) DO UPDATE SET content_hash=excluded.content_hash, embedding=excluded.embedding`)
    .run(nodeId, hash, embeddingBlob(vec));
}

export function getVectorHash(db: DatabaseSyncInstance, nodeId: string): string | null {
  return (db.prepare("SELECT content_hash FROM gm_vectors WHERE node_id=?").get(nodeId) as any)?.content_hash ?? null;
}

export function getVectorStats(db: DatabaseSyncInstance): { count: number; dimensions: number[] } {
  const count = Number((db.prepare("SELECT COUNT(*) AS c FROM gm_vectors").get() as any)?.c ?? 0);
  const rows = db.prepare("SELECT embedding FROM gm_vectors").all() as Array<{ embedding: Uint8Array }>;
  const dimensions = [...new Set(rows.map((row) => row.embedding.byteLength / 4))].sort((a, b) => a - b);
  return { count, dimensions };
}

export type ScoredNode = { node: GmNode; score: number };

export function vectorSearchWithScore(
  db: DatabaseSyncInstance,
  queryVec: number[],
  limit: number,
  minScore?: number,
  withoutTurnMemory = false,
): ScoredNode[] {
  const rows = db.prepare(`
    SELECT v.node_id, v.embedding, n.*
    FROM gm_vectors v JOIN gm_nodes n ON n.id = v.node_id
    WHERE n.status = 'active'
      ${withoutTurnMemory ? `AND NOT EXISTS (
        SELECT 1 FROM gm_node_sources node_source
        JOIN gm_turn_memory_sources memory_source
          ON memory_source.message_id=node_source.message_id
        WHERE node_source.node_id=n.id
      )` : ""}
  `).all() as any[];

  if (!rows.length) return [];

  const q = new Float32Array(queryVec);
  const qNorm = vectorNorm(q);
  if (qNorm === 0) return [];

  return rows
    .map(row => ({
      score: cosineSimilarity(q, qNorm, row.embedding as Uint8Array),
      node: toNode(row),
    }))
    .filter(s => minScore === undefined || s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** 兼容旧接口 */
export function vectorSearch(db: DatabaseSyncInstance, queryVec: number[], limit: number, minScore?: number): GmNode[] {
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
