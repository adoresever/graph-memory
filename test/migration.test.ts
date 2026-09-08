import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "../src/store/sqlite.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, openDb } from "../src/store/db.ts";

let tempDir: string | undefined;

afterEach(() => {
  closeDb();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("database migrations", () => {
  it("opens independently owned connections for lifecycle-scoped hosts", () => {
    const first = openDb(":memory:");
    const second = openDb(":memory:");

    try {
      first.prepare(`INSERT INTO gm_nodes
        (id, type, name, description, content, status, validated_count, source_sessions, created_at, updated_at)
        VALUES ('n1', 'TASK', 'first', '', 'first', 'active', 1, '[]', 1, 1)`).run();

      const firstCount = (first.prepare("SELECT COUNT(*) AS count FROM gm_nodes").get() as any).count;
      const secondCount = (second.prepare("SELECT COUNT(*) AS count FROM gm_nodes").get() as any).count;

      expect(first).not.toBe(second);
      expect(firstCount).toBe(1);
      expect(secondCount).toBe(0);
    } finally {
      first.close();
      second.close();
    }
  });

  it("upgrades a v6 community table and backfills member signatures", () => {
    tempDir = mkdtempSync(join(tmpdir(), "graph-memory-migration-"));
    const dbPath = join(tempDir, "legacy.db");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE _migrations (v INTEGER PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE gm_nodes (
        id TEXT PRIMARY KEY,
        community_id TEXT,
        status TEXT NOT NULL
      );
      CREATE TABLE gm_edges (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('USED_SKILL','SOLVED_BY','REQUIRES','PATCHES','CONFLICTS_WITH')),
        instruction TEXT NOT NULL,
        condition TEXT,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE gm_communities (
        id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        node_count INTEGER NOT NULL DEFAULT 0,
        embedding BLOB,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE gm_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        extracted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      INSERT INTO gm_nodes (id, community_id, status) VALUES
        ('n2', 'c1', 'active'),
        ('n1', 'c1', 'active');
      INSERT INTO gm_edges
        (id, from_id, to_id, type, instruction, condition, session_id, created_at)
        VALUES ('e1', 'n1', 'n2', 'USED_SKILL', 'legacy edge', NULL, 's1', 1);
      INSERT INTO gm_communities
        (id, summary, node_count, embedding, created_at, updated_at)
        VALUES ('c1', 'legacy summary', 2, NULL, 1, 1);
      INSERT INTO gm_messages
        (id, session_id, turn_index, role, content, extracted, created_at)
        VALUES ('done', 's1', 1, 'user', 'done', 1, 1),
               ('todo', 's1', 2, 'assistant', 'todo', 0, 2);
    `);
    const migration = legacy.prepare("INSERT INTO _migrations (v, at) VALUES (?, ?)");
    for (let version = 1; version <= 6; version++) migration.run(version, 1);
    legacy.close();

    const upgraded = getDb(dbPath);
    const columns = upgraded.prepare("PRAGMA table_info(gm_communities)").all() as Array<{ name: string }>;
    const row = upgraded.prepare(
      "SELECT member_signature FROM gm_communities WHERE id='c1'",
    ).get() as { member_signature: string };

    expect(columns.some((column) => column.name === "member_signature")).toBe(true);
    expect(row.member_signature).toMatch(/^[a-f0-9]{40}$/);
    expect(
      (upgraded.prepare("SELECT MAX(v) AS version FROM _migrations").get() as any).version,
    ).toBe(15);
    const sourceColumns = upgraded.prepare("PRAGMA table_info(gm_node_sources)").all() as Array<{ name: string }>;
    expect(sourceColumns.map((column) => column.name)).toEqual([
      "node_id", "session_id", "message_id", "turn_index",
    ]);
    const messageIndexes = upgraded.prepare("PRAGMA index_list(gm_messages)").all() as Array<{ name: string }>;
    expect(messageIndexes.some((index) => index.name === "ix_gm_msg_retention")).toBe(true);
    expect(messageIndexes.some((index) => index.name === "ix_gm_msg_extraction_queue")).toBe(true);
    const messageColumns = upgraded.prepare("PRAGMA table_info(gm_messages)").all() as Array<{ name: string }>;
    expect(messageColumns.map(column => column.name)).toContain("extraction_state");
    const extractionSessionColumns = upgraded.prepare(
      "PRAGMA table_info(gm_extraction_sessions)",
    ).all() as Array<{ name: string }>;
    expect(extractionSessionColumns.map(column => column.name)).toEqual([
      "session_id", "completed_turn", "updated_at",
    ]);
    const turnMemoryColumns = upgraded.prepare(
      "PRAGMA table_info(gm_turn_memories)",
    ).all() as Array<{ name: string }>;
    expect(turnMemoryColumns.map(column => column.name)).toEqual([
      "id", "session_id", "summary", "outcome", "created_at", "updated_at",
    ]);
    const turnMemorySourceColumns = upgraded.prepare(
      "PRAGMA table_info(gm_turn_memory_sources)",
    ).all() as Array<{ name: string }>;
    expect(turnMemorySourceColumns.map(column => column.name)).toEqual([
      "memory_id", "message_id", "turn_index", "source_order",
    ]);
    const queueRows = upgraded.prepare(
      "SELECT id, extraction_state FROM gm_messages ORDER BY id",
    ).all() as Array<{ id: string; extraction_state: string }>;
    expect(queueRows).toEqual([
      { id: "done", extraction_state: "succeeded" },
      { id: "todo", extraction_state: "pending" },
    ]);
    expect((upgraded.prepare("SELECT type FROM gm_edges WHERE id='e1'").get() as any).type).toBe("USED_SKILL");
    upgraded.prepare(`INSERT INTO gm_edges
      (id, from_id, to_id, type, instruction, condition, session_id, created_at)
      VALUES ('e2', 'n1', 'n2', 'RELATES', 'generic predicate', NULL, 's1', 2)`).run();
    upgraded.prepare(`INSERT INTO gm_edges
      (id, from_id, to_id, type, instruction, condition, session_id, created_at)
      VALUES ('e3', 'n2', 'n1', 'SUPERSEDES', 'newer evidence', NULL, 's1', 3)`).run();
    const nodeColumns = upgraded.prepare("PRAGMA table_info(gm_nodes)").all() as Array<{ name: string }>;
    expect(nodeColumns.map(column => column.name)).toContain("temporal_json");
    expect((upgraded.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='gm_node_revisions'",
    ).get() as any).count).toBe(1);
  });
});
