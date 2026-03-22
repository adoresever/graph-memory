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
    } finally {
      db.close();
    }
  });
});
