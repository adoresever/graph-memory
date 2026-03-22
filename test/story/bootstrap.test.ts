import { describe, expect, it } from "vitest";
import { loadStoryConfig } from "../../src/story/config.ts";

describe("loadStoryConfig", () => {
  it("loads anthropic-compatible runtime settings from env", () => {
    process.env.NOVEL_LLM_MODE = "anthropic-compatible";
    process.env.NOVEL_LLM_BASE_URL = "https://api.minimaxi.com/anthropic";
    process.env.NOVEL_LLM_MODEL = "MiniMax-M2.7";
    process.env.NOVEL_LLM_API_KEY = "test-key";
    process.env.NOVEL_DB_PATH = "/tmp/story.db";
    process.env.NOVEL_CHAPTER_EVERY_TURNS = "5";
    process.env.NOVEL_RESET_ON_START = "1";

    const cfg = loadStoryConfig();
    expect(cfg.llm.mode).toBe("anthropic-compatible");
    expect(cfg.llm.baseURL).toContain("minimaxi");
    expect(cfg.llm.model).toBe("MiniMax-M2.7");
    expect(cfg.dbPath).toBe("/tmp/story.db");
    expect(cfg.chapterEveryTurns).toBe(5);
    expect(cfg.resetOnStart).toBe(true);
  });
});
