import { describe, expect, it } from "vitest";
import { createStoryBeliefRepository, listBeliefsForActor, propagateBeliefsFromEvents } from "../../src/story/beliefs.ts";
import { createStoryWorldState } from "../../src/story/world-state.ts";
import { createSeedWorld } from "../../src/story/bootstrap.ts";
import { insertStoryEntities } from "../../src/store/store.ts";
import { createTestDb } from "../helpers.ts";

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

      expect(belief.objectId).toBe("c-su-wan");
      expect(truth.toId).toBe("c-shen-mo");
    } finally {
      db.close();
    }
  });

  it("propagates public events into beliefs but keeps hidden events private", () => {
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

      expect(listBeliefsForActor(db, "c-li-yao")).toHaveLength(1);
      expect(listBeliefsForActor(db, "c-su-wan")).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
