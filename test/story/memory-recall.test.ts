import { describe, expect, it } from "vitest";
import { createStoryWorldState } from "../../src/story/world-state.ts";
import { createSeedWorld } from "../../src/story/bootstrap.ts";
import { insertStoryEvent } from "../../src/store/store.ts";
import { buildRecallPacket } from "../../src/story/memory/recall.ts";
import { createTestDb } from "../helpers.ts";

describe("story memory recall", () => {
  it("recalls thread and relationship context for a pov actor", () => {
    const db = createTestDb();
    try {
      const world = createStoryWorldState(db);
      world.saveSeed(createSeedWorld());
      insertStoryEvent(db, {
        id: "e-secret-realm",
        turnNumber: 1,
        type: "encounter",
        summary: "Secret realm encounter",
        payload: { threadId: "t-secret-realm", subjectId: "c-li-yao" },
      });

      const packet = buildRecallPacket(db, { povId: "c-li-yao", eventIds: ["e-secret-realm"] });
      expect(packet.relationships.length).toBeGreaterThan(0);
      expect(packet.threads.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
