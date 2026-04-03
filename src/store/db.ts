/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import { mkdirSync } from "fs";
import { homedir } from "os";

const _dbMap = new Map<string, DatabaseSyncInstance>();

export function resolvePath(p: string): string {
  return p.replace(/^~/, homedir());
}

export function resolveAgentDbPath(dbPath: string, agentId?: string): string {
  const aid = agentId?.trim();
  if (!aid) return dbPath;

  // Sanitize: only alphanumeric, hyphens, underscores
  const safe = aid.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!safe) return dbPath;

  const lastSlash = Math.max(dbPath.lastIndexOf("/"), dbPath.lastIndexOf("\\"));
  const dotIdx = dbPath.lastIndexOf(".");

  if (dotIdx > lastSlash && dotIdx !== -1) {
    // Has extension: insert suffix before it
    return `${dbPath.slice(0, dotIdx)}-${safe}${dbPath.slice(dotIdx)}`;
  }
  // No extension: append suffix
  return `${dbPath}-${safe}`;
}

export function getDb(dbPath: string): DatabaseSyncInstance {
  const resolved = resolvePath(dbPath);
  const existing = _dbMap.get(resolved);
  if (existing) return existing;

  // 修复：同时处理 Windows 和 Unix 路径分隔符
  const lastSeparator = Math.max(
    resolved.lastIndexOf("/"),
    resolved.lastIndexOf("\\")
  );

  if (lastSeparator > 0) {
    const dirPath = resolved.substring(0, lastSeparator);
    mkdirSync(dirPath, { recursive: true });
  } else if (lastSeparator === 0) {
    // 路径像是 "/file.db" 或 "C:file.db"
    // 在根目录或驱动器根目录，不需要创建目录
  } else {
    // lastSeparator === -1，路径没有分隔符
    // 像是 "file.db"，使用当前目录，不需要创建目录
  }

  const db = new DatabaseSync(resolved);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  _dbMap.set(resolved, db);
  return db;
}

/** 仅用于测试：关闭并重置单例（不传 path 则关闭全部） */
export function closeDb(dbPath?: string): void {
  if (dbPath) {
    const resolved = resolvePath(dbPath);
    const db = _dbMap.get(resolved);
    if (db) { db.close(); _dbMap.delete(resolved); }
  } else {
    for (const db of _dbMap.values()) db.close();
    _dbMap.clear();
  }
}

function migrate(db: DatabaseSyncInstance): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (v INTEGER PRIMARY KEY, at INTEGER NOT NULL)`);
  const cur = (db.prepare("SELECT MAX(v) as v FROM _migrations").get() as any)?.v ?? 0;
  const steps = [m1_core, m2_messages, m3_signals, m4_fts5, m5_vectors, m6_communities];
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
