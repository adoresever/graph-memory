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
      CREATE TABLE gm_communities (
        id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        node_count INTEGER NOT NULL DEFAULT 0,
        embedding BLOB,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO gm_nodes (id, community_id, status) VALUES
        ('n2', 'c1', 'active'),
        ('n1', 'c1', 'active');
      INSERT INTO gm_communities
        (id, summary, node_count, embedding, created_at, updated_at)
        VALUES ('c1', 'legacy summary', 2, NULL, 1, 1);
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
    ).toBe(9);
    const sourceColumns = upgraded.prepare("PRAGMA table_info(gm_node_sources)").all() as Array<{ name: string }>;
    expect(sourceColumns.map((column) => column.name)).toEqual([
      "node_id", "session_id", "message_id", "turn_index",
    ]);
  });
});
