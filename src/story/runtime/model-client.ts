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
  if (cfg.mode === "anthropic-compatible") {
    return buildStoryModelClient(
      createAnthropicCompatibleCompleteFn({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL || "https://api.anthropic.com",
        model: cfg.model,
      }),
    );
  }

  return buildStoryModelClient(
    createStoryCompleteFn("story-openai", cfg.model, {
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
      model: cfg.model,
    }),
  );
}

function buildStoryModelClient(completeFn: CompleteFn): StoryModelClient {
  return {
    rerankActorActions: async (actions) => {
      await ensureModelWarm(completeFn);
      return actions;
    },
    rerankFactionActions: async (actions) => {
      await ensureModelWarm(completeFn);
      return actions;
    },
    rerankChapterFocus: async (candidates) => {
      await ensureModelWarm(completeFn);
      return candidates;
    },
    generateChapter: async () => {
      await ensureModelWarm(completeFn);
      return "";
    },
    summarizeTurn: async () => {
      await ensureModelWarm(completeFn);
      return "";
    },
    extractClaims: async () => {
      await ensureModelWarm(completeFn);
      return [];
    },
  };
}

async function ensureModelWarm(_completeFn: CompleteFn) {
  // placeholder to keep the compiler happy without making actual requests yet
}
