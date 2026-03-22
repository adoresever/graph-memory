import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "@photostructure/sqlite";
import { createStoryBeliefRepository, listBeliefsForActor, propagateBeliefsFromEvents } from "../../src/story/beliefs.ts";
import { createStoryWorldState } from "../../src/story/world-state.ts";
import { createSeedWorld } from "../../src/story/bootstrap.ts";
import { insertStoryEntities } from "../../src/store/store.ts";
import { createTestDb } from "../helpers.ts";
import { closeDb, getDb } from "../../src/store/db.ts";

describe("story beliefs", () => {
  it("stores canonical truth separately from character belief", () => {
    const db = createTestDb();
    try {
      const world = createStoryWorldState(db);
      world.saveSeed(createSeedWorld());
      const repo = createStoryBeliefRepository(db);

      const belief = repo.upsertBelief({
        actorId: "c-li-yao",
        actorKind: "character",
        subjectId: "a-ember-seal",
        predicate: "OWNS",
        objectId: "c-su-wan",
        confidence: 0.7,
      });
      const truth = repo.recordRelation("a-ember-seal", "OWNS", "c-shen-mo");
      const truthRows = db.prepare(`
        SELECT from_id, relation, to_id
        FROM story_relations
        WHERE from_id = ? AND relation = ?
        ORDER BY to_id ASC
      `).all("a-ember-seal", "OWNS") as Array<{ from_id: string; relation: string; to_id: string }>;
      const beliefRows = db.prepare(`
        SELECT actor_id, subject_id, predicate, object_id
        FROM story_beliefs
        WHERE actor_id = ? AND subject_id = ? AND predicate = ?
      `).all("c-li-yao", "a-ember-seal", "OWNS") as Array<{
        actor_id: string;
        subject_id: string;
        predicate: string;
        object_id: string;
      }>;

      expect(belief.objectId).toBe("c-su-wan");
      expect(truth.toId).toBe("c-shen-mo");
      expect(truthRows.some((row) => row.to_id === "c-shen-mo")).toBe(true);
      expect(truthRows.some((row) => row.to_id === "c-su-wan")).toBe(false);
      expect(beliefRows).toEqual([
        {
          actor_id: "c-li-yao",
          subject_id: "a-ember-seal",
          predicate: "OWNS",
          object_id: "c-su-wan",
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("propagates public events into beliefs but keeps hidden events private", () => {
    const db = createTestDb();
    try {
      insertStoryEntities(
        db,
        [
          { id: "c-li-yao", name: "Li Yao" },
          { id: "c-shen-mo", name: "Shen Mo" },
          { id: "c-su-wan", name: "Su Wan" },
        ],
        "character",
      );
      insertStoryEntities(
        db,
        [
          { id: "f-cloud-sword", name: "Cloud Sword Sect" },
          { id: "f-black-river", name: "Black River Hall" },
        ],
        "faction",
      );

      propagateBeliefsFromEvents(db, [
        {
          id: "e-public",
          turnNumber: 1,
          type: "claim",
          summary: "Public claim",
          visibility: "public",
          observers: ["c-li-yao"],
          payload: { subjectId: "a-ember-seal", predicate: "OWNS", objectId: "c-shen-mo" },
        },
        {
          id: "e-hidden",
          turnNumber: 1,
          type: "secret",
          summary: "Hidden secret",
          visibility: "private",
          observers: ["c-shen-mo"],
          payload: { subjectId: "c-li-yao", predicate: "BLOODLINE", objectId: "ancient" },
        },
      ]);

      const liYaoBeliefs = listBeliefsForActor(db, "c-li-yao");
      const shenMoBeliefs = listBeliefsForActor(db, "c-shen-mo");
      const suWanBeliefs = listBeliefsForActor(db, "c-su-wan");
      const cloudSwordBeliefs = listBeliefsForActor(db, "f-cloud-sword");

      expect(liYaoBeliefs).toHaveLength(1);
      expect(shenMoBeliefs.some((belief) =>
        belief.predicate === "BLOODLINE" && belief.objectId === "ancient"
      )).toBe(true);
      expect(suWanBeliefs.some((belief) => belief.predicate === "BLOODLINE")).toBe(false);
      expect(cloudSwordBeliefs.some((belief) => belief.predicate === "BLOODLINE")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("defaults missing visibility to public propagation", () => {
    const db = createTestDb();
    try {
      insertStoryEntities(
        db,
        [{ id: "c-li-yao", name: "Li Yao" }],
        "character",
      );
      insertStoryEntities(
        db,
        [{ id: "f-cloud-sword", name: "Cloud Sword Sect" }],
        "faction",
      );

      propagateBeliefsFromEvents(db, [
        {
          id: "e-default-visibility",
          turnNumber: 1,
          type: "claim",
          summary: "Visibility omitted",
          payload: { subjectId: "a-ember-seal", predicate: "OWNS", objectId: "c-shen-mo" },
        },
      ]);

      expect(listBeliefsForActor(db, "c-li-yao")).toHaveLength(1);
      expect(listBeliefsForActor(db, "f-cloud-sword")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("records events and propagates beliefs through world-state runtime API", () => {
    const db = createTestDb();
    try {
      const world = createStoryWorldState(db);
      world.saveSeed(createSeedWorld());

      world.recordEvents([
        {
          id: "e-runtime-public",
          turnNumber: 1,
          type: "claim",
          summary: "Runtime event",
          payload: { subjectId: "a-ember-seal", predicate: "OWNS", objectId: "c-shen-mo" },
        },
      ]);

      const liYaoBeliefs = listBeliefsForActor(db, "c-li-yao");
      expect(liYaoBeliefs.some((belief) =>
        belief.subjectId === "a-ember-seal" && belief.predicate === "OWNS" && belief.objectId === "c-shen-mo"
      )).toBe(true);
    } finally {
      db.close();
    }
  });

  it("upgrades existing databases by deduping beliefs before enforcing unique invariant", () => {
    closeDb();
    const dir = mkdtempSync(join(tmpdir(), "gm-story-upgrade-"));
    const dbPath = join(dir, "story-upgrade.db");
    const raw = new DatabaseSync(dbPath);
    try {
      raw.exec(`
        CREATE TABLE IF NOT EXISTS _migrations (v INTEGER PRIMARY KEY, at INTEGER NOT NULL);
        INSERT INTO _migrations (v, at) VALUES (7, ${Date.now()});
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
      `);
      raw.prepare(`
        INSERT INTO story_beliefs (id, actor_id, subject_id, predicate, object_id, confidence, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run("sb-old", "c-li-yao", "a-ember-seal", "OWNS", "c-old", 0.3, 1, 10);
      raw.prepare(`
        INSERT INTO story_beliefs (id, actor_id, subject_id, predicate, object_id, confidence, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run("sb-new", "c-li-yao", "a-ember-seal", "OWNS", "c-new", 0.8, 2, 20);
    } finally {
      raw.close();
    }

    try {
      const upgraded = getDb(dbPath);
      const rows = upgraded.prepare(`
        SELECT id, object_id, confidence
        FROM story_beliefs
        WHERE actor_id = ? AND subject_id = ? AND predicate = ?
      `).all("c-li-yao", "a-ember-seal", "OWNS") as Array<{ id: string; object_id: string; confidence: number }>;

      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe("sb-new");
      expect(rows[0]?.object_id).toBe("c-new");
      expect(rows[0]?.confidence).toBe(0.8);
      expect(() =>
        upgraded.prepare(`
          INSERT INTO story_beliefs (id, actor_id, subject_id, predicate, object_id, confidence, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run("sb-dup", "c-li-yao", "a-ember-seal", "OWNS", "c-dup", 0.2, 3, 30),
      ).toThrowError(/UNIQUE|constraint/i);
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
