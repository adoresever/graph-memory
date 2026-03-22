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
        visibility: "public",
        observers: [],
        payload: { threadId: "t-secret-realm", subjectId: "c-li-yao" },
      });
      insertStoryEvent(db, {
        id: "e-li-yao-private",
        turnNumber: 1,
        type: "secret",
        summary: "Li Yao private clue",
        visibility: "private",
        observers: ["c-li-yao"],
        payload: { threadId: "t-secret-realm", subjectId: "c-li-yao" },
      });
      insertStoryEvent(db, {
        id: "e-shen-mo-private",
        turnNumber: 1,
        type: "secret",
        summary: "Shen Mo private clue",
        visibility: "private",
        observers: ["c-shen-mo"],
        payload: { threadId: "t-secret-realm", subjectId: "c-shen-mo" },
      });

      const packet = buildRecallPacket(db, { povId: "c-li-yao", eventIds: ["e-secret-realm"] });
      const relatedForLiYao = buildRecallPacket(db, {
        povId: "c-li-yao",
        eventIds: ["e-secret-realm", "e-li-yao-private", "e-shen-mo-private"],
      }).relatedEvents;
      const relatedIds = relatedForLiYao.map((event) => event.id).sort();

      expect(packet.relationships.length).toBeGreaterThan(0);
      expect(packet.threads.length).toBeGreaterThan(0);
      expect(relatedIds).toEqual(["e-li-yao-private", "e-secret-realm"]);
    } finally {
      db.close();
    }
  });

  it("does not return private events to non-observers", () => {
    const db = createTestDb();
    try {
      const world = createStoryWorldState(db);
      world.saveSeed(createSeedWorld());
      insertStoryEvent(db, {
        id: "e-public-shared",
        turnNumber: 1,
        type: "encounter",
        summary: "Shared event",
        visibility: "public",
        observers: [],
        payload: { threadId: "t-secret-realm", subjectId: "c-li-yao" },
      });
      insertStoryEvent(db, {
        id: "e-private-li-yao",
        turnNumber: 1,
        type: "secret",
        summary: "Li Yao only secret",
        visibility: "private",
        observers: ["c-li-yao"],
        payload: { threadId: "t-secret-realm", subjectId: "c-li-yao" },
      });

      const liYaoPacket = buildRecallPacket(db, { povId: "c-li-yao", eventIds: ["e-public-shared", "e-private-li-yao"] });
      const suWanPacket = buildRecallPacket(db, { povId: "c-su-wan", eventIds: ["e-public-shared", "e-private-li-yao"] });

      expect(liYaoPacket.relatedEvents.map((event) => event.id).sort()).toEqual(["e-private-li-yao", "e-public-shared"]);
      expect(suWanPacket.relatedEvents.map((event) => event.id)).toEqual(["e-public-shared"]);
      expect(suWanPacket.threads.length).toBe(1);
    } finally {
      db.close();
    }
  });
});
