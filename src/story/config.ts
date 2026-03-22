import os from "node:os";

export interface StoryRuntimeConfig {
  dbPath: string;
  llm: {
    mode: "openai-compatible" | "anthropic-compatible";
    baseURL: string;
    model: string;
    apiKey: string;
  };
  chapterEveryTurns: number;
  resetOnStart: boolean;
}

const STORY_DEFAULT_DB_PATH = "~/.graph-memory/story-memory.db";
const STORY_LLM_MODES = new Set<StoryRuntimeConfig["llm"]["mode"]>([
  "openai-compatible",
  "anthropic-compatible",
]);

export function loadStoryConfig(): StoryRuntimeConfig {
  const mode = readStoryLlmMode(process.env.NOVEL_LLM_MODE);
  const baseURL = requireStoryEnv("NOVEL_LLM_BASE_URL");
  const apiKey = requireStoryEnv("NOVEL_LLM_API_KEY");
  const model = readStoryModel(process.env.NOVEL_LLM_MODEL);
  const chapterEveryTurns = readChapterEveryTurns(process.env.NOVEL_CHAPTER_EVERY_TURNS);

  return {
    dbPath: expandStoryPath(process.env.NOVEL_DB_PATH ?? STORY_DEFAULT_DB_PATH),
    llm: {
      mode,
      baseURL,
      model,
      apiKey,
    },
    chapterEveryTurns,
    resetOnStart: process.env.NOVEL_RESET_ON_START === "1",
  };
}

function readStoryLlmMode(rawMode: string | undefined): StoryRuntimeConfig["llm"]["mode"] {
  const mode = rawMode ?? "anthropic-compatible";
  if (STORY_LLM_MODES.has(mode as StoryRuntimeConfig["llm"]["mode"])) {
    return mode as StoryRuntimeConfig["llm"]["mode"];
  }

  throw new Error(
    "[story-runtime] NOVEL_LLM_MODE must be 'openai-compatible' or 'anthropic-compatible'",
  );
}

function requireStoryEnv(name: "NOVEL_LLM_BASE_URL" | "NOVEL_LLM_API_KEY"): string {
  const value = process.env[name]?.trim();
  if (value) {
    return value;
  }

  throw new Error(`[story-runtime] ${name} is required for the story runtime`);
}

function readStoryModel(rawModel: string | undefined): string {
  const model = (rawModel ?? "MiniMax-M2.7").trim();
  if (model) {
    return model;
  }

  throw new Error("[story-runtime] NOVEL_LLM_MODEL is required for the story runtime");
}

function readChapterEveryTurns(rawValue: string | undefined): number {
  const parsed = Number(rawValue ?? 3);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  throw new Error("[story-runtime] NOVEL_CHAPTER_EVERY_TURNS must be a positive integer");
}

function expandStoryPath(pathValue: string): string {
  if (pathValue === "~") {
    return os.homedir();
  }
  if (pathValue.startsWith("~/")) {
    return `${os.homedir()}${pathValue.slice(1)}`;
  }
  return pathValue;
}
