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
});
