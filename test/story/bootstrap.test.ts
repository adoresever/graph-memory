import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadStoryConfig } from "../../src/story/config.ts";
import { createSeedWorld } from "../../src/story/bootstrap.ts";
import { initializeStoryWorld } from "../../src/story/world-state.ts";
import { createTestDb } from "../helpers.ts";

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

  it("rejects an empty llm model value", () => {
    process.env.NOVEL_LLM_MODE = "anthropic-compatible";
    process.env.NOVEL_LLM_BASE_URL = "https://api.minimaxi.com/anthropic";
    process.env.NOVEL_LLM_API_KEY = "test-key";
    process.env.NOVEL_LLM_MODEL = "   ";

    expect(() => loadStoryConfig()).toThrowError(
      "[story-runtime] NOVEL_LLM_MODEL is required for the story runtime",
    );
  });
});

describe("createSeedWorld", () => {
  it("builds a seed world with characters, factions, and threads", () => {
    const world = createSeedWorld();
    expect(world.characters.length).toBeGreaterThanOrEqual(3);
    expect(world.factions.length).toBeGreaterThanOrEqual(2);
    expect(world.threads.length).toBeGreaterThanOrEqual(1);
  });
});

describe("initializeStoryWorld", () => {
  it("seeds the world when empty", () => {
    const db = createTestDb();
    try {
      const world = initializeStoryWorld(db);
      expect(world.listCharacters().length).toBeGreaterThanOrEqual(3);
    } finally {
      db.close();
    }
  });

  it("does not overwrite an existing non-empty world on a second call", () => {
    const db = createTestDb();
    try {
      initializeStoryWorld(db);
      const now = Date.now();
      db.prepare("DELETE FROM story_entities WHERE kind = 'character'").run();
      db.prepare(`
        INSERT INTO story_entities (id, kind, name, payload, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        "c-custom",
        "character",
        "Custom Survivor",
        JSON.stringify({
          id: "c-custom",
          name: "Custom Survivor",
          realm: "Foundation",
          coreDesires: ["survive"],
          shortTermGoals: ["stay-hidden"],
          taboos: ["trust-strangers"],
          resources: { spiritStones: 1, reputation: 1 },
          hiddenTruths: ["none"],
          emotionalVectors: {},
          publicIdentity: "nobody",
          privateIdentity: "someone",
        }),
        "active",
        now,
        now,
      );

      const world = initializeStoryWorld(db);
      const characters = world.listCharacters();
      expect(characters).toHaveLength(1);
      expect(characters[0]?.id).toBe("c-custom");
    } finally {
      db.close();
    }
  });

  it("recovers from invalid normalized payload rows and reseeds instead of crashing", () => {
    const db = createTestDb();
    try {
      db.prepare(`
        INSERT INTO story_entities (id, kind, name, payload, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run("c-bad-json", "character", "Bad Json", "{bad-json", "active", Date.now(), Date.now());

      expect(() => initializeStoryWorld(db)).not.toThrow();
      const world = initializeStoryWorld(db);
      expect(world.listCharacters().length).toBeGreaterThanOrEqual(3);
    } finally {
      db.close();
    }
  });
});
