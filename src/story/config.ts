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

export function loadStoryConfig(options?: { allowMissingLlmEnv?: boolean }): StoryRuntimeConfig {
  const mode = readStoryLlmMode(process.env.NOVEL_LLM_MODE);
  const baseURL = requireStoryEnv("NOVEL_LLM_BASE_URL", options?.allowMissingLlmEnv === true);
  const apiKey = requireStoryEnv("NOVEL_LLM_API_KEY", options?.allowMissingLlmEnv === true);
  const model = readStoryModel(process.env.NOVEL_LLM_MODEL);

  return {
    dbPath: expandStoryPath(process.env.NOVEL_DB_PATH ?? STORY_DEFAULT_DB_PATH),
    llm: {
      mode,
      baseURL,
      model,
      apiKey,
    },
    chapterEveryTurns: readChapterEveryTurns(process.env.NOVEL_CHAPTER_EVERY_TURNS),
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

function requireStoryEnv(
  name: "NOVEL_LLM_BASE_URL" | "NOVEL_LLM_API_KEY",
  allowMissing: boolean,
): string {
  const value = process.env[name]?.trim();
  if (value) {
    return value;
  }
  if (allowMissing) {
    return "injected-model";
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
