import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { createSeedWorld } from "./bootstrap.ts";
import type { SeedWorld, StoryCharacter } from "./types.ts";

const STORY_WORLD_KEY = "seed-world-v1";

export interface StoryWorldState {
  listCharacters(): StoryCharacter[];
  saveSeed(seed: SeedWorld): void;
}

export function createStoryWorldState(db: DatabaseSyncInstance): StoryWorldState {
  ensureStoryStateTable(db);

  return {
    listCharacters() {
      return readSeedWorld(db)?.characters ?? [];
    },
    saveSeed(seed) {
      const payload = JSON.stringify(seed);
      const now = Date.now();
      db.prepare(`
        INSERT INTO story_world_state (state_key, payload, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(state_key) DO UPDATE SET
          payload = excluded.payload,
          updated_at = excluded.updated_at
      `).run(STORY_WORLD_KEY, payload, now);
    },
  };
}

export function initializeStoryWorld(db: DatabaseSyncInstance): StoryWorldState {
  const world = createStoryWorldState(db);
  if (world.listCharacters().length === 0) {
    world.saveSeed(createSeedWorld());
  }
  return world;
}

function ensureStoryStateTable(db: DatabaseSyncInstance) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS story_world_state (
      state_key   TEXT PRIMARY KEY,
      payload     TEXT NOT NULL,
      updated_at  INTEGER NOT NULL
    )
  `);
}

function readSeedWorld(db: DatabaseSyncInstance): SeedWorld | null {
  const row = db.prepare(
    "SELECT payload FROM story_world_state WHERE state_key = ?",
  ).get(STORY_WORLD_KEY) as { payload?: unknown } | undefined;

  if (!row || typeof row.payload !== "string") {
    return null;
  }

  try {
    return JSON.parse(row.payload) as SeedWorld;
  } catch {
    return null;
  }
}
