import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { createStoryModelClient } from "../../src/story/runtime/model-client.ts";

const originalEnv = { ...process.env };
const originalFetch = global.fetch;

describe("story model runtime", () => {
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
  });

  it("surfaces malformed anthropic-compatible responses instead of fabricating chapter output", async () => {
    global.fetch = async () =>
      new Response(JSON.stringify({ content: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const client = createStoryModelClient({
      mode: "anthropic-compatible",
      baseURL: "https://api.minimaxi.com/anthropic",
      model: "MiniMax-M2.7",
      apiKey: "test-key",
    });

    await expect(client.generateChapter({ turnNumber: 1, focus: "sect rivalry" })).rejects.toThrowError(
      "[story-runtime] Anthropic-compatible LLM returned empty content",
    );
  });

  it("rejects invalid rerank payloads instead of returning unchanged actions", async () => {
    global.fetch = async () =>
      new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: "not-json",
            },
          },
        ],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    const client = createStoryModelClient({
      mode: "openai-compatible",
      baseURL: "https://api.example.com/openai",
      model: "MiniMax-M2.7",
      apiKey: "test-key",
    });

    await expect(
      client.rerankActorActions(
        [{ id: "action-1", type: "duel" }],
        { actorId: "hero-1" },
      ),
    ).rejects.toThrowError("[story-runtime] Invalid actor action ranking response");
  });
});

describe("story:run cli", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("runs through the packaged story:run entrypoint and prints runtime config", async () => {
    const result = await execa(
      "npm",
      ["run", "story:run", "--", "--dry-run"],
      {
        cwd: "/Users/victor/Documents/New/graph-memory/.worktrees/world-sim-xianxia-mvp",
        env: {
          ...process.env,
          NOVEL_LLM_MODE: "anthropic-compatible",
          NOVEL_LLM_BASE_URL: "https://api.minimaxi.com/anthropic",
          NOVEL_LLM_MODEL: "MiniMax-M2.7",
          NOVEL_LLM_API_KEY: "test-key",
          NOVEL_DB_PATH: "/tmp/story.db",
          NOVEL_CHAPTER_EVERY_TURNS: "5",
          NOVEL_RESET_ON_START: "0",
        },
      },
    );

    expect(result.stdout).toContain("mode=anthropic-compatible model=MiniMax-M2.7");
    expect(result.stdout).toContain("dbPath=/tmp/story.db");
    expect(result.stdout).toContain("Arguments: --dry-run");
  });
});
