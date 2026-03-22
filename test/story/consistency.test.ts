import { describe, expect, it } from "vitest";
import { initializeStoryWorld } from "../../src/story/world-state.ts";
import { buildStoryWorldSnapshot, validateChapterClaims } from "../../src/story/memory/consistency.ts";
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
});
