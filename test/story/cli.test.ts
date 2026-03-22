import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { createStoryModelClient } from "../../src/story/runtime/model-client.ts";
import {
  createAnthropicCompatibleCompleteFn,
  createStoryCompleteFn,
} from "../../src/engine/llm.ts";
import * as storyCli from "../../src/story/cli.ts";

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

  it("builds run ids with a sortable timestamp prefix and unique suffix", () => {
    const buildRunId = (storyCli as unknown as {
      buildRunId: (startedAt: string, runIdSuffix?: string) => string;
    }).buildRunId;

    expect(buildRunId).toBeTypeOf("function");

    const older = buildRunId("2026-03-22T01:02:03.004Z", "aaaa1111");
    const newer = buildRunId("2026-03-22T01:02:04.004Z", "bbbb2222");
    const duplicateTimeA = buildRunId("2026-03-22T01:02:03.004Z", "aaaa1111");
    const duplicateTimeB = buildRunId("2026-03-22T01:02:03.004Z", "bbbb2222");

    expect(older).toBe("story-2026-03-22T01-02-03-004Z-aaaa1111");
    expect(newer).toBe("story-2026-03-22T01-02-04-004Z-bbbb2222");
    expect(older < newer).toBe(true);
    expect(duplicateTimeA).not.toBe(duplicateTimeB);
    expect(older).not.toMatch(/[:.]/);
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

  it("runs story loop with stub model and reports turns/chapters counters", async () => {
    const tempDbPath = `/tmp/story-task9-${Date.now()}.db`;
    const outputDir = mkdtempSync(path.join(os.tmpdir(), "story-cli-output-"));
    try {
      const result = await execa(
        "npm",
        ["run", "story:run", "--", "--turns=3", "--stub-model", `--output-dir=${outputDir}`],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            NOVEL_LLM_MODE: "anthropic-compatible",
            NOVEL_DB_PATH: tempDbPath,
            NOVEL_CHAPTER_EVERY_TURNS: "3",
            NOVEL_RESET_ON_START: "1",
          },
        },
      );

      expect(result.stdout).toContain("turns=3");
      expect(result.stdout).toContain("chapters=1");
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("uses the default runs directory when --output-dir is omitted", async () => {
    const tempDbPath = `/tmp/story-cli-default-output-${Date.now()}.db`;
    const defaultRunsDir = path.join(repoRoot, "runs");
    let bundlePath = "";

    try {
      const result = await execa(
        "npm",
        ["run", "story:run", "--", "--turns=3", "--stub-model"],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            NOVEL_LLM_MODE: "anthropic-compatible",
            NOVEL_DB_PATH: tempDbPath,
            NOVEL_CHAPTER_EVERY_TURNS: "3",
            NOVEL_RESET_ON_START: "1",
          },
        },
      );

      const bundleLine = result.stdout
        .trim()
        .split("\n")
        .find((line) => line.startsWith("bundle="));
      expect(bundleLine).toBeDefined();

      bundlePath = bundleLine!.slice("bundle=".length).trim();
      expect(bundlePath).toContain(path.join(repoRoot, "runs"));
      expect(existsSync(bundlePath)).toBe(true);
    } finally {
      if (bundlePath) {
        rmSync(bundlePath, { recursive: true, force: true });
      }

      if (existsSync(defaultRunsDir) && readdirSync(defaultRunsDir).length === 0) {
        rmSync(defaultRunsDir, { recursive: true, force: true });
      }
    }
  });

  it("exports a bundle for a stubbed story run and reports the bundle path", async () => {
    const outputDir = mkdtempSync(path.join(os.tmpdir(), "story-cli-output-"));
    try {
      const result = await execa(
        "npm",
        ["run", "story:run", "--", "--turns=3", "--stub-model", `--output-dir=${outputDir}`],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            NOVEL_LLM_MODE: "anthropic-compatible",
            NOVEL_DB_PATH: `/tmp/story-cli-${Date.now()}.db`,
            NOVEL_CHAPTER_EVERY_TURNS: "3",
            NOVEL_RESET_ON_START: "1",
          },
        },
      );

      expect(result.stdout).toContain("turns=3");
      expect(result.stdout).toContain("chapters=1");
      expect(result.stdout).toContain("bundle=");

      const bundleLine = result.stdout
        .trim()
        .split("\n")
        .find((line) => line.startsWith("bundle="));
      expect(bundleLine).toBeDefined();

      const bundlePath = bundleLine!.slice("bundle=".length).trim();
      expect(existsSync(bundlePath)).toBe(true);
      expect(existsSync(path.join(bundlePath, "index.json"))).toBe(true);
      expect(existsSync(path.join(bundlePath, "world-log.jsonl"))).toBe(true);
      expect(existsSync(path.join(bundlePath, "chapters", "chapter-001.md"))).toBe(true);

      const index = JSON.parse(readFileSync(path.join(bundlePath, "index.json"), "utf8")) as {
        turnCount: number;
        chapterCount: number;
        bundlePath: string;
      };
      expect(index.turnCount).toBe(3);
      expect(index.chapterCount).toBe(1);
      expect(index.bundlePath).toBe(bundlePath);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
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
