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
import { runStoryLoop } from "../../src/story/runtime/run-loop.ts";
import { createTestDb } from "../helpers.ts";

describe("story long run coherence", () => {
  afterEach(() => {
    delete process.env.NOVEL_LLM_BASE_URL;
    delete process.env.NOVEL_LLM_API_KEY;
    delete process.env.NOVEL_CHAPTER_EVERY_TURNS;
    delete process.env.NOVEL_RESET_ON_START;
  });

  it("keeps active threads coherent across twenty turns", async () => {
    delete process.env.NOVEL_LLM_BASE_URL;
    delete process.env.NOVEL_LLM_API_KEY;
    delete process.env.NOVEL_CHAPTER_EVERY_TURNS;
    delete process.env.NOVEL_RESET_ON_START;

    const db = createTestDb();
    try {
      const result = await runStoryLoop(db, { turns: 20, model: fakeStoryModel() });
      expect(result.worldLogs).toHaveLength(20);
      expect(result.finalDirectorState.activeThreads.length).toBeGreaterThan(0);
      expect(result.consistencyIssues).toHaveLength(0);
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
