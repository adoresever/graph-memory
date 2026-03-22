import type { CompleteFn } from "../../engine/llm.ts";
import type { StoryRuntimeConfig } from "../config.ts";
import { createAnthropicCompatibleCompleteFn, createStoryCompleteFn } from "../../engine/llm.ts";

export type StoryAction = {
  id?: string;
  type: string;
  summary?: string;
  [key: string]: unknown;
};

export interface ActorDecisionInput {
  actorId?: string;
  prompt?: string;
  scene?: string;
}

export interface FactionDecisionInput {
  factionId?: string;
  prompt?: string;
  stakes?: string[];
}

export interface ChapterSelection {
  id: string;
  focus: string;
  score: number;
}

export interface NarrativeDirectorInput {
  directorId?: string;
  activeThreads?: string[];
  notes?: string;
}

export interface ChapterPacket {
  turnNumber: number;
  focus: string;
  summary?: string;
}

export interface TurnSummaryInput {
  turnNumber: number;
  highlights: string[];
  events: string[];
}

export interface StoryClaim {
  subjectId: string;
  predicate: string;
  objectId?: string;
  valueText?: string;
  evidenceSpan: string;
}

export interface StoryModelClient {
  rerankActorActions(actions: StoryAction[], context: ActorDecisionInput): Promise<StoryAction[]>;
  rerankFactionActions(actions: StoryAction[], context: FactionDecisionInput): Promise<StoryAction[]>;
  rerankChapterFocus(
    candidates: ChapterSelection[],
    context: NarrativeDirectorInput,
  ): Promise<ChapterSelection[]>;
  generateChapter(packet: ChapterPacket): Promise<string>;
  summarizeTurn(input: TurnSummaryInput): Promise<string>;
  extractClaims(prose: string): Promise<StoryClaim[]>;
}

export function createStoryModelClient(cfg: StoryRuntimeConfig["llm"]): StoryModelClient {
  const completeFn =
    cfg.mode === "anthropic-compatible"
      ? createAnthropicCompatibleCompleteFn({
          apiKey: cfg.apiKey,
          baseURL: cfg.baseURL,
          model: cfg.model,
        })
      : createStoryCompleteFn({
          apiKey: cfg.apiKey,
          baseURL: cfg.baseURL,
          model: cfg.model,
        });

  return buildStoryModelClient(completeFn);
}

function buildStoryModelClient(completeFn: CompleteFn): StoryModelClient {
  return {
    rerankActorActions: async (actions, context) => {
      await callModel(completeFn, "rerank actor actions", JSON.stringify({ actions, context }));
      return actions;
    },
    rerankFactionActions: async (actions, context) => {
      await callModel(completeFn, "rerank faction actions", JSON.stringify({ actions, context }));
      return actions;
    },
    rerankChapterFocus: async (candidates, context) => {
      await callModel(completeFn, "rerank chapter focus", JSON.stringify({ candidates, context }));
      return candidates;
    },
    generateChapter: async (packet) => {
      const prompt = `Generate chapter for turn ${packet.turnNumber}, focus ${packet.focus}`;
      const narrative = await callModel(completeFn, "generate chapter", prompt);
      return narrative || "";
    },
    summarizeTurn: async (input) => {
      const summaryPrompt = `Summarize turn ${input.turnNumber} with highlights ${input.highlights.join(";")}`;
      const summary = await callModel(completeFn, "summarize turn", summaryPrompt);
      return summary || "";
    },
    extractClaims: async (prose) => {
      await callModel(completeFn, "extract claims", prose);
      return [];
    },
  };
}

async function callModel(completeFn: CompleteFn, operation: string, user: string) {
  try {
    return await completeFn(operation, user);
  } catch (err) {
    if (err instanceof Error) {
      throw err;
    }
    throw new Error(`[story-runtime] Failed to ${operation}`);
  }
}
