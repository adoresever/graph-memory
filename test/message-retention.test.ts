import { describe, expect, it } from "vitest";

import {
  normalizeMessageRetentionPolicy,
  runMessageRetention,
} from "../src/store/retention.ts";
import { createTestDb, insertNode } from "./helpers.ts";

function insertMessage(
  db: ReturnType<typeof createTestDb>,
  id: string,
  session: string,
  turn: number,
  role: string,
  options: { extracted?: number; createdAt?: number; content?: string } = {},
) {
  db.prepare(`
    INSERT INTO gm_messages
      (id, session_id, turn_index, role, content, extracted, extraction_state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    session,
    turn,
    role,
    options.content ?? `${role}-${turn}`,
    options.extracted ?? 1,
    (options.extracted ?? 1) === 1 ? "succeeded" : "pending",
    options.createdAt ?? 1_700_000_000_000 + turn,
  );
}

function ids(db: ReturnType<typeof createTestDb>): string[] {
  return (db.prepare("SELECT id FROM gm_messages ORDER BY id").all() as Array<{ id: string }>)
    .map((row) => row.id);
}

describe("message retention policy", () => {
  it("defaults to keep=all and preserves every row exactly", () => {
    const db = createTestDb();
    insertMessage(db, "extracted", "s1", 1, "user");
    insertMessage(db, "pending", "s1", 2, "assistant", { extracted: 0 });

    const result = runMessageRetention(db, normalizeMessageRetentionPolicy(undefined));

    expect(result.policy).toBe("all");
    expect(result.selectedRows).toBe(0);
    expect(result.deletedRows).toBe(0);
    expect(ids(db)).toEqual(["extracted", "pending"]);
    db.close();
  });

  it("deletes only extracted, unreferenced rows", () => {
    const db = createTestDb();
    insertMessage(db, "delete-me", "s1", 1, "user");
    insertMessage(db, "pending", "s1", 2, "assistant", { extracted: 0 });
    insertMessage(db, "referenced", "s1", 3, "assistant");
    const nodeId = insertNode(db, { name: "retained-source" });
    db.prepare(`
      INSERT INTO gm_node_sources (node_id, session_id, message_id, turn_index)
      VALUES (?, 's1', 'referenced', 3)
    `).run(nodeId);

    const result = runMessageRetention(
      db,
      normalizeMessageRetentionPolicy({ keep: "referenced", batchSize: 10 }),
    );

    expect(result.selectedRows).toBe(1);
    expect(result.deletedRows).toBe(1);
    expect(ids(db)).toEqual(["pending", "referenced"]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM gm_node_sources").get()).toEqual({ count: 1 });
    db.close();
  });

  it("never deletes quarantined messages even if a legacy flag is inconsistent", () => {
    const db = createTestDb();
    insertMessage(db, "safe", "s1", 1, "user");
    db.prepare(`
      UPDATE gm_messages SET extraction_state='quarantined' WHERE id='safe'
    `).run();

    const result = runMessageRetention(
      db,
      normalizeMessageRetentionPolicy({ keep: "referenced", batchSize: 10 }),
    );
    expect(result.deletedRows).toBe(0);
    expect(ids(db)).toEqual(["safe"]);
    db.close();
  });

  it("preserves complete event spans for the newest real user turns", () => {
    const db = createTestDb();
    for (const [turn, role] of [
      [1, "user"],
      [2, "assistant"],
      [3, "tool"],
      [4, "user"],
      [5, "assistant"],
      [6, "user"],
      [7, "assistant"],
    ] as Array<[number, string]>) {
      insertMessage(db, `m${turn}`, "s1", turn, role);
    }

    const result = runMessageRetention(
      db,
      normalizeMessageRetentionPolicy({ keep: "recent", recentTurns: 2, batchSize: 20 }),
    );

    expect(result.deletedRows).toBe(3);
    expect(ids(db)).toEqual(["m4", "m5", "m6", "m7"]);
    db.close();
  });

  it("combines turn and age windows conservatively and retains malformed timestamps", () => {
    const db = createTestDb();
    const now = 2_000_000_000_000;
    insertMessage(db, "old", "s1", 1, "user", { createdAt: now - 10 * 86_400_000 });
    insertMessage(db, "recent-by-age", "s1", 2, "assistant", { createdAt: now - 1_000 });
    insertMessage(db, "bad-time", "s1", 3, "assistant", { createdAt: 0 });
    insertMessage(db, "new-user", "s1", 4, "user", { createdAt: now - 1_000 });
    insertMessage(db, "new-answer", "s1", 5, "assistant", { createdAt: now - 1_000 });

    const result = runMessageRetention(
      db,
      normalizeMessageRetentionPolicy({
        keep: "recent",
        recentTurns: 1,
        retentionDays: 3,
        batchSize: 20,
      }),
      now,
    );

    expect(result.deletedRows).toBe(1);
    expect(ids(db)).toEqual(["bad-time", "new-answer", "new-user", "recent-by-age"]);
    db.close();
  });

  it("supports bounded dry runs without deleting candidates", () => {
    const db = createTestDb();
    for (let index = 1; index <= 3; index += 1) {
      insertMessage(db, `m${index}`, `s${index}`, index, index === 1 ? "user" : "tool");
    }

    const result = runMessageRetention(
      db,
      normalizeMessageRetentionPolicy({
        keep: "referenced",
        dryRun: true,
        batchSize: 2,
      }),
    );

    expect(result.dryRun).toBe(true);
    expect(result.selectedRows).toBe(2);
    expect(result.deletedRows).toBe(0);
    expect(result.hasMore).toBe(true);
    expect(result.selectedSessions).toBe(2);
    expect(result.byRole).toEqual({ user: 1, tool: 1 });
    expect(ids(db)).toEqual(["m1", "m2", "m3"]);
    db.close();
  });

  it("rolls back the entire batch when deletion fails", () => {
    const db = createTestDb();
    insertMessage(db, "a", "s1", 1, "user");
    insertMessage(db, "b", "s1", 2, "assistant");
    db.exec(`
      CREATE TRIGGER fail_retention_delete
      BEFORE DELETE ON gm_messages
      WHEN OLD.id='b'
      BEGIN
        SELECT RAISE(ABORT, 'simulated retention failure');
      END;
    `);

    expect(() => runMessageRetention(
      db,
      normalizeMessageRetentionPolicy({ keep: "referenced", batchSize: 10 }),
    )).toThrow(/simulated retention failure/);
    expect(ids(db)).toEqual(["a", "b"]);
    db.close();
  });

  it("rejects destructive or ambiguous invalid configuration before opening the DB", () => {
    expect(() => normalizeMessageRetentionPolicy({ keep: "recent" })).toThrow(/requires/);
    expect(() => normalizeMessageRetentionPolicy({ keep: "recent", recentTurns: -1 })).toThrow(/recentTurns/);
    expect(() => normalizeMessageRetentionPolicy({ keep: "referenced", batchSize: 0 })).toThrow(/batchSize/);
    expect(() => normalizeMessageRetentionPolicy({ keep: "invalid" as any })).toThrow(/must be all/);
  });
});
