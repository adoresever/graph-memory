/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */
import { createHash } from "node:crypto";
import { DatabaseSync } from "./sqlite.js";
import { mkdirSync } from "fs";
import { homedir } from "os";
let _db = null;
export function resolvePath(p) {
    return p.replace(/^~/, homedir());
}
/**
 * Open an independently owned database instance.
 *
 * Host adapters with explicit lifecycles (for example a DSH Cordis fiber)
 * should use this API and close the returned instance from their disposer.
 * The legacy OpenClaw adapter continues to use getDb() below.
 */
export function openDb(dbPath) {
    const resolved = resolvePath(dbPath);
    // 修复：同时处理 Windows 和 Unix 路径分隔符
    const lastSeparator = Math.max(resolved.lastIndexOf("/"), resolved.lastIndexOf("\\"));
    if (lastSeparator > 0) {
        const dirPath = resolved.substring(0, lastSeparator);
        mkdirSync(dirPath, { recursive: true });
    }
    else if (lastSeparator === 0) {
        // 路径像是 "/file.db" 或 "C:file.db"
        // 在根目录或驱动器根目录，不需要创建目录
    }
    else {
        // lastSeparator === -1，路径没有分隔符
        // 像是 "file.db"，使用当前目录，不需要创建目录
    }
    const db = new DatabaseSync(resolved);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
    return db;
}
/**
 * Legacy process-wide database accessor retained for OpenClaw compatibility.
 * New host adapters must prefer openDb() so each plugin instance owns its
 * connection and can dispose it without affecting another profile/fiber.
 */
export function getDb(dbPath) {
    if (_db)
        return _db;
    _db = openDb(dbPath);
    return _db;
}
/** 仅用于测试：关闭并重置单例 */
export function closeDb() {
    if (_db) {
        _db.close();
        _db = null;
    }
}
function migrate(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS _migrations (v INTEGER PRIMARY KEY, at INTEGER NOT NULL)`);
    const cur = db.prepare("SELECT MAX(v) as v FROM _migrations").get()?.v ?? 0;
    const steps = [
        m1_core,
        m2_messages,
        m3_signals,
        m4_fts5,
        m5_vectors,
        m6_communities,
        m7_community_signature,
        m8_backfill_community_signatures,
        m9_node_sources,
        m10_message_retention_index,
        m11_extraction_queue_state,
        m12_extraction_turn_watermark,
        m13_generic_navigation_edges,
        m14_temporal_revisions,
        m15_turn_memories,
    ];
    for (let i = cur; i < steps.length; i++) {
        steps[i](db);
        db.prepare("INSERT INTO _migrations (v,at) VALUES (?,?)").run(i + 1, Date.now());
    }
}
// ─── 分层轮次记忆：摘要索引 → 图谱导航 → 原始消息证据 ──────
function m15_turn_memories(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS gm_turn_memories (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      summary     TEXT NOT NULL,
      outcome     TEXT NOT NULL CHECK(outcome IN ('completed','partial','failed','informational','unknown')),
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_gm_turn_memories_session
      ON gm_turn_memories(session_id, updated_at);

    CREATE TABLE IF NOT EXISTS gm_turn_memory_sources (
      memory_id   TEXT NOT NULL REFERENCES gm_turn_memories(id) ON DELETE CASCADE,
      message_id  TEXT NOT NULL REFERENCES gm_messages(id) ON DELETE CASCADE,
      turn_index  INTEGER NOT NULL,
      source_order INTEGER NOT NULL,
      PRIMARY KEY (memory_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS ix_gm_turn_memory_sources_message
      ON gm_turn_memory_sources(message_id, memory_id);

    CREATE TABLE IF NOT EXISTS gm_turn_vectors (
      memory_id    TEXT PRIMARY KEY REFERENCES gm_turn_memories(id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL,
      embedding    BLOB NOT NULL
    );
  `);
}
// ─── 时间语义与通用修订关系 ──────────────────────────────────
function m14_temporal_revisions(db) {
    const nodeColumns = new Set(db.prepare("PRAGMA table_info(gm_nodes)").all().map(column => column.name));
    if (!nodeColumns.has("temporal_json")) {
        db.exec("ALTER TABLE gm_nodes ADD COLUMN temporal_json TEXT NOT NULL DEFAULT '{}'");
    }
    db.exec(`
    CREATE TABLE IF NOT EXISTS gm_node_revisions (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id                  TEXT NOT NULL REFERENCES gm_nodes(id) ON DELETE CASCADE,
      previous_description     TEXT NOT NULL,
      previous_content         TEXT NOT NULL,
      previous_temporal_json   TEXT NOT NULL DEFAULT '{}',
      previous_validated_count INTEGER NOT NULL,
      previous_source_refs     TEXT NOT NULL DEFAULT '[]',
      replacement_session_id   TEXT NOT NULL,
      replaced_at              INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_gm_node_revisions_node
      ON gm_node_revisions(node_id, replaced_at);
  `);
    const schema = String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='gm_edges'").get()?.sql ?? "");
    if (schema.includes("'SUPERSEDES'"))
        return;
    db.exec("PRAGMA foreign_keys = OFF");
    try {
        db.exec(`
      BEGIN;
      CREATE TABLE gm_edges_next (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL REFERENCES gm_nodes(id),
        to_id TEXT NOT NULL REFERENCES gm_nodes(id),
        type TEXT NOT NULL CHECK(type IN ('RELATES','SUPERSEDES','USED_SKILL','SOLVED_BY','REQUIRES','PATCHES','CONFLICTS_WITH')),
        instruction TEXT NOT NULL,
        condition TEXT,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO gm_edges_next
        (id, from_id, to_id, type, instruction, condition, session_id, created_at)
      SELECT id, from_id, to_id, type, instruction, condition, session_id, created_at FROM gm_edges;
      DROP TABLE gm_edges;
      ALTER TABLE gm_edges_next RENAME TO gm_edges;
      CREATE INDEX ix_gm_edges_from ON gm_edges(from_id);
      CREATE INDEX ix_gm_edges_to ON gm_edges(to_id);
      COMMIT;
    `);
    }
    catch (error) {
        try {
            db.exec("ROLLBACK");
        }
        catch { /* no active transaction */ }
        throw error;
    }
    finally {
        db.exec("PRAGMA foreign_keys = ON");
    }
}
// ─── 通用导航关系：谓词存于 instruction，不绑定业务领域 ───────
function m13_generic_navigation_edges(db) {
    const schema = String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='gm_edges'").get()?.sql ?? "");
    if (!schema) {
        db.exec(`
      CREATE TABLE gm_edges (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL REFERENCES gm_nodes(id),
        to_id TEXT NOT NULL REFERENCES gm_nodes(id),
        type TEXT NOT NULL CHECK(type IN ('RELATES','USED_SKILL','SOLVED_BY','REQUIRES','PATCHES','CONFLICTS_WITH')),
        instruction TEXT NOT NULL,
        condition TEXT,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX ix_gm_edges_from ON gm_edges(from_id);
      CREATE INDEX ix_gm_edges_to ON gm_edges(to_id);
    `);
        return;
    }
    if (schema.includes("'RELATES'"))
        return;
    db.exec("PRAGMA foreign_keys = OFF");
    try {
        db.exec(`
      BEGIN;
      CREATE TABLE gm_edges_next (
        id          TEXT PRIMARY KEY,
        from_id     TEXT NOT NULL REFERENCES gm_nodes(id),
        to_id       TEXT NOT NULL REFERENCES gm_nodes(id),
        type        TEXT NOT NULL CHECK(type IN ('RELATES','USED_SKILL','SOLVED_BY','REQUIRES','PATCHES','CONFLICTS_WITH')),
        instruction TEXT NOT NULL,
        condition   TEXT,
        session_id  TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      INSERT INTO gm_edges_next
        (id, from_id, to_id, type, instruction, condition, session_id, created_at)
      SELECT id, from_id, to_id, type, instruction, condition, session_id, created_at
      FROM gm_edges;
      DROP TABLE gm_edges;
      ALTER TABLE gm_edges_next RENAME TO gm_edges;
      CREATE INDEX ix_gm_edges_from ON gm_edges(from_id);
      CREATE INDEX ix_gm_edges_to ON gm_edges(to_id);
      COMMIT;
    `);
    }
    catch (error) {
        try {
            db.exec("ROLLBACK");
        }
        catch { /* no active transaction */ }
        throw error;
    }
    finally {
        db.exec("PRAGMA foreign_keys = ON");
    }
}
// ─── 完整轮次水位：后台抽取不得读取仍在生成的当前轮 ─────────────
function m12_extraction_turn_watermark(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS gm_extraction_sessions (
      session_id      TEXT PRIMARY KEY,
      completed_turn  INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
  `);
}
// ─── 可审计抽取队列：待处理 / 成功 / 隔离 ──────────────────────
function m11_extraction_queue_state(db) {
    const columns = new Set(db.prepare("PRAGMA table_info(gm_messages)").all()
        .map(column => column.name));
    if (!columns.has("extraction_state")) {
        db.exec(`ALTER TABLE gm_messages ADD COLUMN extraction_state TEXT NOT NULL DEFAULT 'pending'
      CHECK(extraction_state IN ('pending', 'succeeded', 'quarantined'))`);
    }
    if (!columns.has("extraction_attempts")) {
        db.exec("ALTER TABLE gm_messages ADD COLUMN extraction_attempts INTEGER NOT NULL DEFAULT 0");
    }
    if (!columns.has("extraction_error")) {
        db.exec("ALTER TABLE gm_messages ADD COLUMN extraction_error TEXT");
    }
    if (!columns.has("extraction_next_retry_at")) {
        db.exec("ALTER TABLE gm_messages ADD COLUMN extraction_next_retry_at INTEGER");
    }
    if (!columns.has("extraction_updated_at")) {
        db.exec("ALTER TABLE gm_messages ADD COLUMN extraction_updated_at INTEGER");
    }
    db.exec(`
    UPDATE gm_messages
      SET extraction_state=CASE WHEN extracted=1 THEN 'succeeded' ELSE 'pending' END,
          extraction_updated_at=COALESCE(extraction_updated_at, created_at);
    CREATE INDEX IF NOT EXISTS ix_gm_msg_extraction_queue
      ON gm_messages(extraction_state, extraction_next_retry_at, session_id, turn_index);
  `);
}
// ─── 有界原始消息保留策略查询 ────────────────────────────────
function m10_message_retention_index(db) {
    db.exec(`
    CREATE INDEX IF NOT EXISTS ix_gm_msg_retention
    ON gm_messages(extracted, created_at, session_id, turn_index);
  `);
}
// ─── 精确溯源：图节点 → 原始消息 ──────────────────────────────
function m9_node_sources(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS gm_node_sources (
      node_id     TEXT NOT NULL REFERENCES gm_nodes(id) ON DELETE CASCADE,
      session_id  TEXT NOT NULL,
      message_id  TEXT NOT NULL REFERENCES gm_messages(id) ON DELETE CASCADE,
      turn_index  INTEGER NOT NULL,
      PRIMARY KEY (node_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS ix_gm_node_sources_node ON gm_node_sources(node_id, turn_index);
    CREATE INDEX IF NOT EXISTS ix_gm_node_sources_session ON gm_node_sources(session_id, turn_index);
  `);
}
// ─── 核心表：节点 + 边 ──────────────────────────────────────
function m1_core(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS gm_nodes (
      id              TEXT PRIMARY KEY,
      type            TEXT NOT NULL CHECK(type IN ('TASK','SKILL','EVENT')),
      name            TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      content         TEXT NOT NULL,
      temporal_json   TEXT NOT NULL DEFAULT '{}',
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
      type        TEXT NOT NULL CHECK(type IN ('RELATES','SUPERSEDES','USED_SKILL','SOLVED_BY','REQUIRES','PATCHES','CONFLICTS_WITH')),
      instruction TEXT NOT NULL,
      condition   TEXT,
      session_id  TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_gm_edges_from ON gm_edges(from_id);
    CREATE INDEX IF NOT EXISTS ix_gm_edges_to   ON gm_edges(to_id);

    CREATE TABLE IF NOT EXISTS gm_node_revisions (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id                  TEXT NOT NULL REFERENCES gm_nodes(id) ON DELETE CASCADE,
      previous_description     TEXT NOT NULL,
      previous_content         TEXT NOT NULL,
      previous_temporal_json   TEXT NOT NULL DEFAULT '{}',
      previous_validated_count INTEGER NOT NULL,
      previous_source_refs     TEXT NOT NULL DEFAULT '[]',
      replacement_session_id   TEXT NOT NULL,
      replaced_at              INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_gm_node_revisions_node
      ON gm_node_revisions(node_id, replaced_at);
  `);
}
// ─── 消息存储 ────────────────────────────────────────────────
function m2_messages(db) {
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
function m3_signals(db) {
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
function m4_fts5(db) {
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
    }
    catch {
        // FTS5 不可用时静默降级到 LIKE 搜索
    }
}
// ─── 向量存储 ────────────────────────────────────────────────
function m5_vectors(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS gm_vectors (
      node_id      TEXT PRIMARY KEY REFERENCES gm_nodes(id),
      content_hash TEXT NOT NULL,
      embedding    BLOB NOT NULL
    );
  `);
}
// ─── 社区描述存储 ────────────────────────────────────────────
function m6_communities(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS gm_communities (
      id               TEXT PRIMARY KEY,
      summary          TEXT NOT NULL,
      node_count       INTEGER NOT NULL DEFAULT 0,
      embedding        BLOB,
      member_signature TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
  `);
}
function m7_community_signature(db) {
    const cols = db.prepare("PRAGMA table_info(gm_communities)").all();
    const hasMemberSignature = cols.some((col) => col.name === "member_signature");
    if (!hasMemberSignature) {
        db.exec("ALTER TABLE gm_communities ADD COLUMN member_signature TEXT");
    }
    db.exec("CREATE INDEX IF NOT EXISTS ix_gm_communities_member_signature ON gm_communities(member_signature)");
}
function m8_backfill_community_signatures(db) {
    const missing = db.prepare(`
    SELECT id FROM gm_communities
    WHERE member_signature IS NULL OR member_signature=''
  `).all();
    for (const row of missing) {
        const members = db.prepare(`
      SELECT id FROM gm_nodes
      WHERE community_id=? AND status='active'
      ORDER BY id
    `).all(row.id);
        if (!members.length)
            continue;
        const memberSignature = createHash("sha1")
            .update(members.map((member) => member.id).join(","))
            .digest("hex");
        db.prepare(`
      UPDATE gm_communities
      SET member_signature=?, updated_at=updated_at
      WHERE id=?
    `).run(memberSignature, row.id);
    }
}
