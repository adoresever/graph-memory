/**
 * graph-memory — 测试辅助
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 *
 * 提供内存 SQLite 数据库，每个测试用例独立，互不干扰
 */

import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";

/**
 * 创建内存数据库 + 完整 migration
 * 等价于 getDb() 但用 :memory: 不写磁盘
 */
export function createTestDb(): DatabaseSyncInstance {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  // m1: 核心表
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

  // m2: 消息
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

  // m3: 信号
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

  // m4: FTS5
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS gm_nodes_fts USING fts5(
        name, description, content,
        content=gm_nodes, content_rowid=rowid
      );
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
  } catch { /* FTS5 不可用 */ }

  // m5: 向量
  db.exec(`
    CREATE TABLE IF NOT EXISTS gm_vectors (
      node_id      TEXT PRIMARY KEY REFERENCES gm_nodes(id),
      content_hash TEXT NOT NULL,
      embedding    BLOB NOT NULL
    );
  `);

  // m6: 社区
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

  // m7: 故事世界状态
  db.exec(`
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

    CREATE TABLE IF NOT EXISTS story_world_state (
      state_key   TEXT PRIMARY KEY,
      payload     TEXT NOT NULL,
      updated_at  INTEGER NOT NULL
    );
  `);

  return db;
}

/**
 * 快速插入测试节点
 */
export function insertNode(
  db: DatabaseSyncInstance,
  opts: {
    id?: string;
    type?: string;
    name: string;
    description?: string;
    content?: string;
    status?: string;
    validatedCount?: number;
    sessions?: string[];
  },
): string {
  const id = opts.id ?? `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`
    INSERT INTO gm_nodes (id, type, name, description, content, status, validated_count, source_sessions, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.type ?? "SKILL",
    opts.name,
    opts.description ?? `desc of ${opts.name}`,
    opts.content ?? `content of ${opts.name}`,
    opts.status ?? "active",
    opts.validatedCount ?? 1,
    JSON.stringify(opts.sessions ?? ["test-session"]),
    Date.now(),
    Date.now(),
  );
  return id;
}

/**
 * 快速插入测试边
 */
export function insertEdge(
  db: DatabaseSyncInstance,
  opts: {
    fromId: string;
    toId: string;
    type?: string;
    instruction?: string;
  },
): void {
  const id = `e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`
    INSERT INTO gm_edges (id, from_id, to_id, type, instruction, session_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.fromId,
    opts.toId,
    opts.type ?? "USED_SKILL",
    opts.instruction ?? "test instruction",
    "test-session",
    Date.now(),
  );
}
