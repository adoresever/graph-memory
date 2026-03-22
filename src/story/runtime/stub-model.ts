import type {
  ChapterPacket,
  ChapterSelection,
  FactionDecisionInput,
  NarrativeDirectorInput,
  StoryAction,
  StoryClaim,
  StoryModelClient,
  TurnSummaryInput,
} from "./model-client.ts";

export function createStubStoryModelClient(): StoryModelClient {
  return {
    rerankActorActions: async (actions: StoryAction[]) => actions,
    rerankFactionActions: async (actions: StoryAction[], _context: FactionDecisionInput) => actions,
    rerankChapterFocus: async (candidates: ChapterSelection[], _context: NarrativeDirectorInput) => candidates,
    generateChapter: async (packet: ChapterPacket) =>
      `Stub chapter turn ${packet.turnNumber} focus ${packet.focus}. ${packet.summary ?? ""}`.trim(),
    summarizeTurn: async (input: TurnSummaryInput) =>
      `Stub turn ${input.turnNumber}: ${input.highlights.join("; ") || "no-highlights"}`,
    extractClaims: async (_prose: string): Promise<StoryClaim[]> => [],
  };
}
