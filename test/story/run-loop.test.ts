import { afterEach, describe, expect, it } from "vitest";
import type {
  ActorDecisionInput,
  ChapterPacket,
  FactionDecisionInput,
  NarrativeDirectorInput,
  StoryAction,
  StoryClaim,
  StoryModelClient,
  TurnSummaryInput,
} from "../../src/story/runtime/model-client.ts";
import { getNextStoryTurnNumber, runStoryLoop } from "../../src/story/runtime/run-loop.ts";
import { initializeStoryWorld } from "../../src/story/world-state.ts";
import { createTestDb } from "../helpers.ts";

describe("story run loop", () => {
  afterEach(() => {
    delete process.env.NOVEL_LLM_BASE_URL;
    delete process.env.NOVEL_LLM_API_KEY;
    delete process.env.NOVEL_CHAPTER_EVERY_TURNS;
    delete process.env.NOVEL_RESET_ON_START;
  });

  it("emits chapter prose every three turns by default", async () => {
    delete process.env.NOVEL_LLM_BASE_URL;
    delete process.env.NOVEL_LLM_API_KEY;
    delete process.env.NOVEL_CHAPTER_EVERY_TURNS;
    delete process.env.NOVEL_RESET_ON_START;

    const db = createTestDb();
    try {
      const result = await runStoryLoop(db, { turns: 3, model: fakeStoryModel() });
      expect(result.chapters).toHaveLength(1);
      expect(result.worldLogs).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  it("preserves seeded narrative signals when resetOnStart is true", () => {
    const db = createTestDb();
    try {
      initializeStoryWorld(db);

      expect(countActiveNarrativeSignals(db)).toBeGreaterThan(0);
      expect(getNextStoryTurnNumber(db, true)).toBe(1);
      expect(countActiveNarrativeSignals(db)).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

function fakeStoryModel(): StoryModelClient {
  return {
    rerankActorActions: async (actions: StoryAction[], _context: ActorDecisionInput): Promise<StoryAction[]> => actions,
    rerankFactionActions: async (
      actions: StoryAction[],
      _context: FactionDecisionInput,
    ): Promise<StoryAction[]> => actions,
    rerankChapterFocus: async (
      candidates: { id: string; focus: string; score: number }[],
      _context: NarrativeDirectorInput,
    ): Promise<{ id: string; focus: string; score: number }[]> => candidates,
    generateChapter: async (packet: ChapterPacket): Promise<string> =>
      `Turn ${packet.turnNumber} chapter focus ${packet.focus}`,
    summarizeTurn: async (_input: TurnSummaryInput): Promise<string> => "Stable turn summary.",
    extractClaims: async (_prose: string): Promise<StoryClaim[]> => [],
  };
}

function countActiveNarrativeSignals(db: ReturnType<typeof createTestDb>): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM story_narrative_signals
    WHERE status = 'active'
  `).get() as { count: number };
  return row.count;
}
