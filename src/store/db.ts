/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import { mkdirSync } from "fs";
import { homedir } from "os";

let _db: DatabaseSyncInstance | null = null;

export function resolvePath(p: string): string {
  return p.replace(/^~/, homedir());
}

export function getDb(dbPath: string): DatabaseSyncInstance {
  if (_db) return _db;
  const resolved = resolvePath(dbPath);
  mkdirSync(resolved.substring(0, resolved.lastIndexOf("/")), { recursive: true });
  _db = new DatabaseSync(resolved);
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA foreign_keys = ON");
  migrate(_db);
  return _db;
}

/** 仅用于测试：关闭并重置单例 */
export function closeDb(): void {
  if (_db) { _db.close(); _db = null; }
}

function migrate(db: DatabaseSyncInstance): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (v INTEGER PRIMARY KEY, at INTEGER NOT NULL)`);
  const cur = (db.prepare("SELECT MAX(v) as v FROM _migrations").get() as any)?.v ?? 0;
  const steps = [m1_core, m2_messages, m3_signals, m4_fts5, m5_vectors, m6_communities, m7_story];
  for (let i = cur; i < steps.length; i++) {
    steps[i](db);
    db.prepare("INSERT INTO _migrations (v,at) VALUES (?,?)").run(i + 1, Date.now());
  }
}

// ─── 核心表：节点 + 边 ──────────────────────────────────────

function m1_core(db: DatabaseSyncInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gm_nodes (
      id              TEXT PRIMARY KEY,
      type            TEXT NOT NULL CHECK(type IN ('TASK','SKILL','EVENT')),
      name            TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      content         TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deprecated')),
      validated_count INTEGER NOT NULL DEFAULT 1,
      source_sessions TEXT NOT NULL DEFAULT '[]',
      community_id    TEXT,
      pagerank        REAL NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_gm_nodes_name ON gm_nodes(name);
    CREATE INDEX IF NOT EXISTS ix_gm_nodes_type_status ON gm_nodes(type, status);
    CREATE INDEX IF NOT EXISTS ix_gm_nodes_community ON gm_nodes(community_id);

    CREATE TABLE IF NOT EXISTS gm_edges (
      id          TEXT PRIMARY KEY,
      from_id     TEXT NOT NULL REFERENCES gm_nodes(id),
      to_id       TEXT NOT NULL REFERENCES gm_nodes(id),
      type        TEXT NOT NULL CHECK(type IN ('USED_SKILL','SOLVED_BY','REQUIRES','PATCHES','CONFLICTS_WITH')),
      instruction TEXT NOT NULL,
      condition   TEXT,
      session_id  TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_gm_edges_from ON gm_edges(from_id);
    CREATE INDEX IF NOT EXISTS ix_gm_edges_to   ON gm_edges(to_id);
  `);
}

// ─── 消息存储 ────────────────────────────────────────────────

function m2_messages(db: DatabaseSyncInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gm_messages (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      turn_index  INTEGER NOT NULL,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      extracted   INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_gm_msg_session ON gm_messages(session_id, turn_index);
  `);
}

// ─── 信号存储 ────────────────────────────────────────────────

function m3_signals(db: DatabaseSyncInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gm_signals (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      turn_index  INTEGER NOT NULL,
      type        TEXT NOT NULL,
      data        TEXT NOT NULL DEFAULT '{}',
      processed   INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_gm_sig_session ON gm_signals(session_id, processed);
  `);
}

// ─── FTS5 全文索引 ───────────────────────────────────────────

function m4_fts5(db: DatabaseSyncInstance): void {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS gm_nodes_fts USING fts5(
        name,
        description,
        content,
        content=gm_nodes,
        content_rowid=rowid
      );
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS gm_nodes_ai AFTER INSERT ON gm_nodes BEGIN
        INSERT INTO gm_nodes_fts(rowid, name, description, content)
        VALUES (NEW.rowid, NEW.name, NEW.description, NEW.content);
      END;
      CREATE TRIGGER IF NOT EXISTS gm_nodes_ad AFTER DELETE ON gm_nodes BEGIN
        INSERT INTO gm_nodes_fts(gm_nodes_fts, rowid, name, description, content)
        VALUES ('delete', OLD.rowid, OLD.name, OLD.description, OLD.content);
      END;
      CREATE TRIGGER IF NOT EXISTS gm_nodes_au AFTER UPDATE ON gm_nodes BEGIN
        INSERT INTO gm_nodes_fts(gm_nodes_fts, rowid, name, description, content)
        VALUES ('delete', OLD.rowid, OLD.name, OLD.description, OLD.content);
        INSERT INTO gm_nodes_fts(rowid, name, description, content)
        VALUES (NEW.rowid, NEW.name, NEW.description, NEW.content);
      END;
    `);
  } catch {
    // FTS5 不可用时静默降级到 LIKE 搜索
  }
}

// ─── 向量存储 ────────────────────────────────────────────────

function m5_vectors(db: DatabaseSyncInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gm_vectors (
      node_id      TEXT PRIMARY KEY REFERENCES gm_nodes(id),
      content_hash TEXT NOT NULL,
      embedding    BLOB NOT NULL
    );
  `);
}

// ─── 社区描述存储 ────────────────────────────────────────────

function m6_communities(db: DatabaseSyncInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gm_communities (
      id          TEXT PRIMARY KEY,
      summary     TEXT NOT NULL,
      node_count  INTEGER NOT NULL DEFAULT 0,
      embedding   BLOB,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `);
}

// ─── 故事状态持久化 ──────────────────────────────────────────

function m7_story(db: DatabaseSyncInstance): void {
  db.exec(`
    -- Story tables intentionally defer foreign keys for now: seed/update flows may persist
    -- partial payload snapshots and cross-kind references before later normalization tasks.
    CREATE TABLE IF NOT EXISTS story_entities (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS story_relations (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      to_id TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'public',
      intensity REAL NOT NULL DEFAULT 1,
      source_event_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS story_events (
      id TEXT PRIMARY KEY,
      turn_number INTEGER NOT NULL,
      type TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS story_turns (
      turn_number INTEGER PRIMARY KEY,
      summary TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS story_beliefs (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object_id TEXT NOT NULL,
      confidence REAL NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS story_chapters (
      id TEXT PRIMARY KEY,
      turn_number INTEGER NOT NULL,
      pov_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      prose TEXT NOT NULL,
      claims_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS story_narrative_signals (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      related_id TEXT,
      weight REAL NOT NULL DEFAULT 1,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS story_director_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS ix_story_entities_kind_status ON story_entities(kind, status);
    CREATE INDEX IF NOT EXISTS ix_story_relations_from ON story_relations(from_id);
    CREATE INDEX IF NOT EXISTS ix_story_relations_to ON story_relations(to_id);
    CREATE INDEX IF NOT EXISTS ix_story_events_turn_number ON story_events(turn_number);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_story_beliefs_actor_subject_predicate
      ON story_beliefs(actor_id, subject_id, predicate);
    CREATE INDEX IF NOT EXISTS ix_story_narrative_signals_subject_kind_status
      ON story_narrative_signals(subject_id, kind, status);
  `);
}
