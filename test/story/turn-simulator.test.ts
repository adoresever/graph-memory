import { describe, expect, it } from "vitest";
import { createSeedWorld } from "../../src/story/bootstrap.ts";
import { createStoryWorldState } from "../../src/story/world-state.ts";
import { runStoryTurn, type StoryTurnInput } from "../../src/story/turn-simulator.ts";
import type { StoryAction } from "../../src/story/runtime/model-client.ts";
import { createTestDb } from "../helpers.ts";

describe("story turn simulator", () => {
  it("advances one turn and records resolved events", async () => {
    const db = createTestDb();
    try {
      const world = createStoryWorldState(db);
      world.saveSeed(createSeedWorld());

      const seedContext: StoryTurnInput = {
        turnNumber: 1,
        model: {
          rerankActorActions: async (actions: StoryAction[]) => actions,
          rerankFactionActions: async (actions: StoryAction[]) => actions,
        },
      };

      const result = await runStoryTurn(db, seedContext);

      expect(result.turnNumber).toBe(1);
      expect(result.events.length).toBeGreaterThan(0);
      expect(result.stateChanges.length).toBeGreaterThan(0);

      const turnRow = db.prepare("SELECT turn_number FROM story_turns WHERE turn_number = 1").get() as
        | { turn_number: number }
        | undefined;
      expect(turnRow?.turn_number).toBe(1);

      const eventCount = (db.prepare("SELECT COUNT(*) as c FROM story_events WHERE turn_number = 1").get() as
        { c: number }).c;
      expect(eventCount).toBe(result.events.length);
    } finally {
      db.close();
    }
  });

  it("creates conflicts when competing actions target the same artifact", async () => {
    const db = createTestDb();
    try {
      const world = createStoryWorldState(db);
      world.saveSeed(createSeedWorld());

      const conflictFixture: StoryTurnInput = {
        turnNumber: 2,
        model: {
          rerankActorActions: async (actions: StoryAction[]) => forceSeekArtifact(actions),
          rerankFactionActions: async (actions: StoryAction[]) => forceSeekArtifact(actions),
        },
      };

      const result = await runStoryTurn(db, conflictFixture);

      expect(result.events.some((event) => event.type === "artifact-conflict")).toBe(true);
    } finally {
      db.close();
    }
  });
});

function forceSeekArtifact(actions: StoryAction[]): StoryAction[] {
  const seek = actions.filter((action) => action.type === "seek-artifact");
  return seek.length > 0 ? [...seek, ...actions.filter((action) => action.type !== "seek-artifact")] : actions;
}
