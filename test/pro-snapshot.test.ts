import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/store/db.ts";
import { upsertEdge, upsertNode } from "../src/store/store.ts";
import { SqliteGraphSnapshotStore } from "../pro/sqlite.ts";
import type { GraphNodeId } from "../pro/types.ts";

const cleanup: string[] = [];

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graph-memory-pro-"));
  cleanup.push(dir);
  return join(dir, "memory.db");
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SQLite Pro snapshot store", () => {
  it("returns a bounded projection without session identifiers or node content", () => {
    const dbPath = fixture();
    const db = openDb(dbPath);
    const task = upsertNode(db, {
      type: "TASK",
      name: "ship-dsh-plugin",
      description: "Ship a native DSH plugin",
      content: "private implementation notes",
    }, "dsh:session-secret").node;
    const skill = upsertNode(db, {
      type: "SKILL",
      name: "plugin-install",
      description: "Install a DSH bundle",
      content: "private command history",
    }, "dsh:session-secret").node;
    upsertEdge(db, {
      fromId: task.id,
      toId: skill.id,
      type: "USED_SKILL",
      instruction: "Use the installer",
      sessionId: "dsh:session-secret",
    });
    db.close();

    const store = new SqliteGraphSnapshotStore({
      dbPath,
      defaultNodeLimit: 1,
      detailContentLimit: 8,
    });
    const first = store.getSnapshot();
    expect(first.nodes).toHaveLength(1);
    expect(first.truncated.nodes).toBe(true);
    expect(first.totals).toEqual({ nodes: 2, edges: 1 });
    expect(JSON.stringify(first)).not.toContain("session-secret");
    expect(JSON.stringify(first)).not.toContain("private implementation notes");

    const complete = store.getSnapshot({ maxNodes: 2 });
    expect(complete.nodes).toHaveLength(2);
    expect(complete.edges).toHaveLength(1);
    expect(store.getNodeDetail(task.id as GraphNodeId)).toMatchObject({
      content: "private ",
      contentTruncated: true,
    });
    store.close();
  });

  it("validates limits and node types at the persisted-data boundary", () => {
    const store = new SqliteGraphSnapshotStore({ dbPath: fixture(), maxNodeLimit: 10 });
    expect(() => store.getSnapshot({ maxNodes: 11 })).toThrow(/maxNodes/);
    expect(() => store.getSnapshot({ nodeTypes: ["OTHER" as never] })).toThrow(/nodeTypes/);
    store.close();
    expect(() => store.getSnapshot()).toThrow(/closed/);
  });
});
