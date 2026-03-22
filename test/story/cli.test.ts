import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runStoryCli } from "../../src/story/cli.ts";

const originalEnv = { ...process.env };

describe("runStoryCli", () => {
  beforeEach(() => {
    process.env.NOVEL_LLM_MODE = "anthropic-compatible";
    process.env.NOVEL_LLM_BASE_URL = "https://api.minimaxi.com/anthropic";
    process.env.NOVEL_LLM_MODEL = "MiniMax-M2.7";
    process.env.NOVEL_LLM_API_KEY = "test-key";
    process.env.NOVEL_DB_PATH = "/tmp/story.db";
    process.env.NOVEL_CHAPTER_EVERY_TURNS = "5";
    process.env.NOVEL_RESET_ON_START = "0";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("exposes the runtime client while logging config state", async () => {
    const client = await runStoryCli(["--dry-run"]);
    expect(client).toBeDefined();
    expect(typeof client.generateChapter).toBe("function");
    expect(typeof client.summarizeTurn).toBe("function");
  });
});
