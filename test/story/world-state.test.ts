import { describe, expect, it } from "vitest";
import { createSeedWorld } from "../../src/story/bootstrap.ts";
import { createStoryWorldState } from "../../src/story/world-state.ts";
import { createTestDb } from "../helpers.ts";

describe("story world-state persistence", () => {
  it("persists story entities and relationships", () => {
    const db = createTestDb();
    try {
      const world = createStoryWorldState(db);
      world.saveSeed(createSeedWorld());

      expect(world.listCharacters()).toHaveLength(3);
      expect(world.listThreads()[0]?.status).toBe("active");
      const relationRows = db.prepare("SELECT from_id, relation, to_id FROM story_relations ORDER BY id").all() as Array<{
        from_id: string;
        relation: string;
        to_id: string;
      }>;
      expect(relationRows).toHaveLength(3);
      expect(relationRows[0]).toEqual({ from_id: "a-ember-seal", relation: "OWNS", to_id: "c-shen-mo" });
    } finally {
      db.close();
    }
  });

  it("returns paused threads from payloads", () => {
    const db = createTestDb();
    try {
      const world = createStoryWorldState(db);
      const seed = createSeedWorld();
      seed.threads = [{ id: "t-paused", name: "Paused thread", status: "paused" }];
      world.saveSeed(seed);

      const threads = world.listThreads();
      expect(threads).toHaveLength(1);
      expect(threads[0]?.id).toBe("t-paused");
      expect(threads[0]?.status).toBe("paused");
    } finally {
      db.close();
    }
  });

  it("records turns, events, and narrative signals", () => {
    const db = createTestDb();
    try {
      const world = createStoryWorldState(db);
      world.recordTurn({ turnNumber: 2, summary: "Turn 2 summary", payload: { phase: "aftermath" } });
      world.recordEvents([
        { id: "ev-1", turnNumber: 2, type: "conflict", summary: "Conflict begins", payload: { at: "cloud-peak" } },
      ]);
      world.upsertNarrativeSignal({
        id: "ns-test",
        kind: "foreshadow",
        subjectId: "c-li-yao",
        weight: 0.9,
        payloadJson: JSON.stringify({ omen: "red-sky" }),
        status: "active",
      });

      const turnRow = db.prepare("SELECT turn_number, summary FROM story_turns WHERE turn_number = 2").get() as
        | { turn_number: number; summary: string }
        | undefined;
      expect(turnRow).toEqual({ turn_number: 2, summary: "Turn 2 summary" });

      const eventCount = (db.prepare("SELECT COUNT(*) as c FROM story_events WHERE turn_number = 2").get() as { c: number }).c;
      expect(eventCount).toBe(1);

      const signalRow = db.prepare("SELECT kind, subject_id FROM story_narrative_signals WHERE id = ?").get("ns-test") as
        | { kind: string; subject_id: string }
        | undefined;
      expect(signalRow).toEqual({ kind: "foreshadow", subject_id: "c-li-yao" });
    } finally {
      db.close();
    }
  });

  it("does not persist canonical relations/signals that reference missing custom-seed ids", () => {
    const db = createTestDb();
    try {
      const world = createStoryWorldState(db);
      const seed = createSeedWorld();
      seed.characters = [
        {
          id: "c-custom",
          name: "Custom Disciple",
          realm: "Foundation",
          coreDesires: ["survive"],
          shortTermGoals: ["hide"],
          taboos: ["betray-allies"],
          resources: { spiritStones: 5, reputation: 1 },
          hiddenTruths: ["none"],
          emotionalVectors: {},
          publicIdentity: "disciple",
          privateIdentity: "outsider",
        },
      ];
      seed.factions = [
        {
          id: "f-custom",
          name: "Custom Sect",
          agenda: ["persist"],
          constraints: ["low-power"],
          doctrine: "adapt",
          internalBlocks: [],
          strategicTargets: [],
          publicPosture: "neutral",
          hiddenOperations: [],
        },
      ];
      seed.locations = [{ id: "l-custom", name: "Custom Peak", kind: "sect" }];
      seed.artifacts = [{ id: "a-custom", name: "Custom Relic", kind: "token", ownerId: "c-custom" }];
      seed.threads = [{ id: "t-custom", name: "Custom Thread", status: "active" }];
      seed.rules = [{ id: "r-custom", name: "Custom Rule", effect: "custom-effect" }];

      world.saveSeed(seed);

      const relationCount = (db.prepare("SELECT COUNT(*) as c FROM story_relations").get() as { c: number }).c;
      const signalCount = (db.prepare("SELECT COUNT(*) as c FROM story_narrative_signals").get() as { c: number }).c;
      expect(relationCount).toBe(0);
      expect(signalCount).toBe(0);
    } finally {
      db.close();
    }
  });

  it("removes malformed entities and their obvious dependent rows during recovery", () => {
    const db = createTestDb();
    try {
      const now = Date.now();
      db.prepare(`
        INSERT INTO story_entities (id, kind, name, payload, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run("c-bad", "character", "Broken Character", "{bad-json", "active", now, now);
      db.prepare(`
        INSERT INTO story_relations (id, from_id, relation, to_id, visibility, intensity, source_event_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("sr-bad", "c-bad", "KNOWS", "c-other", "public", 1, null, now, now);
      db.prepare(`
        INSERT INTO story_narrative_signals (id, kind, subject_id, related_id, weight, payload_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("ns-bad", "secret", "c-bad", "t-other", 1, "{}", "active", now, now);

      const world = createStoryWorldState(db);
      expect(world.listCharacters()).toEqual([]);

      const relationCount = (db.prepare("SELECT COUNT(*) as c FROM story_relations WHERE id = 'sr-bad'").get() as {
        c: number;
      }).c;
      const signalCount = (db.prepare("SELECT COUNT(*) as c FROM story_narrative_signals WHERE id = 'ns-bad'").get() as {
        c: number;
      }).c;
      expect(relationCount).toBe(0);
      expect(signalCount).toBe(0);
    } finally {
      db.close();
    }
  });

  it("rolls back malformed cleanup atomically when a dependent delete fails", () => {
    const db = createTestDb();
    try {
      const now = Date.now();
      db.prepare(`
        INSERT INTO story_entities (id, kind, name, payload, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run("c-bad-savepoint", "character", "Broken Character", "{bad-json", "active", now, now);
      db.prepare(`
        INSERT INTO story_relations (id, from_id, relation, to_id, visibility, intensity, source_event_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("sr-bad-savepoint", "c-bad-savepoint", "KNOWS", "c-other", "public", 1, null, now, now);
      db.prepare(`
        INSERT INTO story_narrative_signals (id, kind, subject_id, related_id, weight, payload_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("ns-bad-savepoint", "secret", "c-bad-savepoint", "t-other", 1, "{}", "active", now, now);

      db.exec(`
        CREATE TRIGGER story_signal_delete_blocker
        BEFORE DELETE ON story_narrative_signals
        BEGIN
          SELECT RAISE(ABORT, 'signal-delete-blocked');
        END;
      `);

      const world = createStoryWorldState(db);
      expect(() => world.listCharacters()).toThrowError(/signal-delete-blocked/);

      const relationCount = (db.prepare("SELECT COUNT(*) as c FROM story_relations WHERE id = 'sr-bad-savepoint'").get() as {
        c: number;
      }).c;
      const signalCount = (db.prepare("SELECT COUNT(*) as c FROM story_narrative_signals WHERE id = 'ns-bad-savepoint'").get() as {
        c: number;
      }).c;
      const entityCount = (db.prepare("SELECT COUNT(*) as c FROM story_entities WHERE id = 'c-bad-savepoint'").get() as {
        c: number;
      }).c;
      expect(relationCount).toBe(1);
      expect(signalCount).toBe(1);
      expect(entityCount).toBe(1);
    } finally {
      db.close();
    }
  });
});
