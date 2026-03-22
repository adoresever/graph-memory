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
});
