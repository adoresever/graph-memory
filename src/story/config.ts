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

export function loadStoryConfig(): StoryRuntimeConfig {
  return {
    dbPath: process.env.NOVEL_DB_PATH ?? "~/.graph-memory/story-memory.db",
    llm: {
      mode: (process.env.NOVEL_LLM_MODE as StoryRuntimeConfig["llm"]["mode"]) ?? "anthropic-compatible",
      baseURL: process.env.NOVEL_LLM_BASE_URL ?? "",
      model: process.env.NOVEL_LLM_MODEL ?? "MiniMax-M2.7",
      apiKey: process.env.NOVEL_LLM_API_KEY ?? "",
    },
    chapterEveryTurns: Number(process.env.NOVEL_CHAPTER_EVERY_TURNS ?? 3),
    resetOnStart: process.env.NOVEL_RESET_ON_START === "1",
  };
}
