import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { createStoryModelClient } from "../../src/story/runtime/model-client.ts";
import {
  createAnthropicCompatibleCompleteFn,
  createStoryCompleteFn,
} from "../../src/engine/llm.ts";

const originalEnv = { ...process.env };
const originalFetch = global.fetch;
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
type FetchArgs = Parameters<typeof fetch>;

function setFetchMock(
  impl: (input: FetchArgs[0], init?: FetchArgs[1]) => Promise<Response>,
) {
  global.fetch = Object.assign(
    (async (input: FetchArgs[0], init?: FetchArgs[1]) => impl(input, init)) as typeof fetch,
    {
      preconnect: originalFetch.preconnect?.bind(originalFetch),
    },
  );
}

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
    setFetchMock(async () =>
      new Response(JSON.stringify({ content: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

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
    setFetchMock(async () =>
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
      }));

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
        cwd: repoRoot,
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

describe("story llm helpers", () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("builds openai-compatible requests with the expected url, method, and auth header", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    setFetchMock(async (input, init) => {
      requests.push({ input, init });
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: "ranked output",
            },
          },
        ],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const complete = createStoryCompleteFn({
      baseURL: "https://api.example.com/openai/",
      model: "MiniMax-M2.7",
      apiKey: "story-openai-key",
    });

    await expect(complete("system prompt", "user prompt")).resolves.toBe("ranked output");
    expect(String(requests[0]?.input)).toBe("https://api.example.com/openai/chat/completions");
    expect(requests[0]?.init?.method).toBe("POST");
    expect((requests[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer story-openai-key");
  });

  it("builds anthropic-compatible requests with the expected url, method, and auth header", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    setFetchMock(async (input, init) => {
      requests.push({ input, init });
      return new Response(JSON.stringify({
        content: [
          {
            type: "text",
            text: "chapter prose",
          },
        ],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const complete = createAnthropicCompatibleCompleteFn({
      baseURL: "https://api.minimaxi.com/anthropic/",
      model: "MiniMax-M2.7",
      apiKey: "story-anthropic-key",
    });

    await expect(complete("system prompt", "user prompt")).resolves.toBe("chapter prose");
    expect(String(requests[0]?.input)).toBe("https://api.minimaxi.com/anthropic/v1/messages");
    expect(requests[0]?.init?.method).toBe("POST");
    expect((requests[0]?.init?.headers as Record<string, string>)["x-api-key"]).toBe("story-anthropic-key");
  });

  it("includes an anthropic error body snippet on non-2xx responses", async () => {
    setFetchMock(async () =>
      new Response("bad auth from provider", {
        status: 401,
        headers: { "Content-Type": "text/plain" },
      }));

    const complete = createAnthropicCompatibleCompleteFn({
      baseURL: "https://api.minimaxi.com/anthropic/",
      model: "MiniMax-M2.7",
      apiKey: "story-anthropic-key",
    });

    await expect(complete("system prompt", "user prompt")).rejects.toThrowError(
      "[story-runtime] Anthropic-compatible LLM API 401: bad auth from provider",
    );
  });
});
