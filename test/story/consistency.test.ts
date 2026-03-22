import { describe, expect, it } from "vitest";
import { insertStoryRelation } from "../../src/store/store.ts";
import { initializeStoryWorld } from "../../src/story/world-state.ts";
import {
  buildStoryWorldSnapshot,
  validateChapterClaims,
  validateRecentChapters,
} from "../../src/story/memory/consistency.ts";
import { createTestDb } from "../helpers.ts";

describe("story consistency validation", () => {
  it("flags chapter claims that contradict current world state", () => {
    const db = createTestDb();
    try {
      initializeStoryWorld(db);
      const worldSnapshot = buildStoryWorldSnapshot(db);
      const issues = validateChapterClaims(worldSnapshot, [
        {
          subjectId: "a-ember-seal",
          predicate: "OWNS",
          objectId: "c-li-yao",
          evidenceSpan: "Li Yao now controls the Ember Seal.",
        },
      ]);

      expect(issues).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("returns only contradictory claims for recent chapters", () => {
    const db = createTestDb();
    try {
      initializeStoryWorld(db);
      db.prepare(`
        INSERT INTO story_chapters (id, turn_number, pov_id, summary, prose, claims_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        "sch-test",
        1,
        "c-li-yao",
        "Summary",
        "Prose",
        JSON.stringify([
          {
            subjectId: "a-ember-seal",
            predicate: "OWNS",
            objectId: "c-li-yao",
            evidenceSpan: "Li Yao now controls the Ember Seal.",
          },
        ]),
        Date.now(),
      );

      const issues = validateRecentChapters(db);

      expect(issues).toEqual([
        {
          subjectId: "a-ember-seal",
          predicate: "OWNS",
          objectId: "c-li-yao",
          evidenceSpan: "Li Yao now controls the Ember Seal.",
        },
      ]);
      expect(issues[0]).not.toHaveProperty("chapterId");
    } finally {
      db.close();
    }
  });

  it("does not flag older chapter claims when later relation rows preserve the original fact", () => {
    const db = createTestDb();
    try {
      initializeStoryWorld(db);
      db.prepare(`
        INSERT INTO story_chapters (id, turn_number, pov_id, summary, prose, claims_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        "sch-earlier",
        1,
        "c-shen-mo",
        "Summary",
        "Prose",
        JSON.stringify([
          {
            subjectId: "a-ember-seal",
            predicate: "OWNS",
            objectId: "c-shen-mo",
            evidenceSpan: "Shen Mo held the Ember Seal during the first turn.",
          },
        ]),
        200,
      );
      insertStoryRelation(db, {
        id: "sr-ember-seal-owns-li-yao-later",
        fromId: "a-ember-seal",
        relation: "OWNS",
        toId: "c-li-yao",
        visibility: "public",
      });

      const issues = validateRecentChapters(db);

      expect(issues).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("still flags older chapter claims that were already wrong before later relation changes", () => {
    const db = createTestDb();
    try {
      initializeStoryWorld(db);
      db.prepare(`
        INSERT INTO story_chapters (id, turn_number, pov_id, summary, prose, claims_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        "sch-wrong-earlier",
        1,
        "c-li-yao",
        "Summary",
        "Prose",
        JSON.stringify([
          {
            subjectId: "a-ember-seal",
            predicate: "OWNS",
            objectId: "c-li-yao",
            evidenceSpan: "Li Yao supposedly held the Ember Seal during the first turn.",
          },
        ]),
        200,
      );
      insertStoryRelation(db, {
        id: "sr-ember-seal-owns-su-wan-later",
        fromId: "a-ember-seal",
        relation: "OWNS",
        toId: "c-su-wan",
        visibility: "public",
      });

      const issues = validateRecentChapters(db);

      expect(issues).toEqual([
        {
          subjectId: "a-ember-seal",
          predicate: "OWNS",
          objectId: "c-li-yao",
          evidenceSpan: "Li Yao supposedly held the Ember Seal during the first turn.",
        },
      ]);
    } finally {
      db.close();
    }
  });
});
