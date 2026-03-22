import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runStoryCli } from "../../src/story/cli.ts";

const originalEnv = { ...process.env };
const originalFetch = global.fetch;
const originalConsoleLog = console.log;

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
    global.fetch = originalFetch;
    console.log = originalConsoleLog;
  });

  it("logs the configured runtime mode and surfaces provider failures", async () => {
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    global.fetch = async () =>
      new Response("bad auth", {
        status: 401,
        headers: { "Content-Type": "text/plain" },
      });

    const client = await runStoryCli(["--dry-run"]);
    expect(logs.some((line) => line.includes("mode=anthropic-compatible model=MiniMax-M2.7"))).toBe(true);
    expect(logs.some((line) => line.includes("dbPath=/tmp/story.db"))).toBe(true);
    await expect(client.generateChapter({ turnNumber: 1, focus: "sect rivalry" })).rejects.toThrowError(
      "[story-runtime] Anthropic-compatible LLM API 401",
    );
  });
});
