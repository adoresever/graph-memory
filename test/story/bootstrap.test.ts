import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadStoryConfig } from "../../src/story/config.ts";

const originalEnv = { ...process.env };

describe("loadStoryConfig", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

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
    expect(cfg.llm.apiKey).toBe("test-key");
    expect(cfg.dbPath).toBe("/tmp/story.db");
    expect(cfg.chapterEveryTurns).toBe(5);
    expect(cfg.resetOnStart).toBe(true);
  });

  it("expands the default db path into the user home directory", () => {
    delete process.env.NOVEL_DB_PATH;
    process.env.NOVEL_LLM_MODE = "anthropic-compatible";
    process.env.NOVEL_LLM_BASE_URL = "https://api.minimaxi.com/anthropic";
    process.env.NOVEL_LLM_API_KEY = "test-key";

    const cfg = loadStoryConfig();
    expect(cfg.dbPath).toBe(`${os.homedir()}/.graph-memory/story-memory.db`);
  });

  it("rejects invalid runtime modes with a story-specific error", () => {
    process.env.NOVEL_LLM_MODE = "not-a-mode";
    process.env.NOVEL_LLM_BASE_URL = "https://api.minimaxi.com/anthropic";
    process.env.NOVEL_LLM_API_KEY = "test-key";

    expect(() => loadStoryConfig()).toThrowError(
      "[story-runtime] NOVEL_LLM_MODE must be 'openai-compatible' or 'anthropic-compatible'",
    );
  });

  it("rejects missing story llm credentials instead of falling back to unrelated env", () => {
    process.env.NOVEL_LLM_MODE = "anthropic-compatible";
    process.env.NOVEL_LLM_BASE_URL = "https://api.minimaxi.com/anthropic";
    delete process.env.NOVEL_LLM_API_KEY;
    process.env.ANTHROPIC_API_KEY = "do-not-use";

    expect(() => loadStoryConfig()).toThrowError(
      "[story-runtime] NOVEL_LLM_API_KEY is required for the story runtime",
    );
  });

  it("rejects invalid chapter cadence values", () => {
    process.env.NOVEL_LLM_MODE = "anthropic-compatible";
    process.env.NOVEL_LLM_BASE_URL = "https://api.minimaxi.com/anthropic";
    process.env.NOVEL_LLM_API_KEY = "test-key";
    process.env.NOVEL_CHAPTER_EVERY_TURNS = "0";

    expect(() => loadStoryConfig()).toThrowError(
      "[story-runtime] NOVEL_CHAPTER_EVERY_TURNS must be a positive integer",
    );
  });
});
