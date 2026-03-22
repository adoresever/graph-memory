import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { createSeedWorld } from "./bootstrap.ts";
import type { SeedWorld, StoryCharacter, StoryThread } from "./types.ts";
import {
  insertStoryEntities,
  insertStoryEvent,
  insertStoryRelation,
  insertStoryTurn,
  listStoryEntitiesByKind,
  type StoryNarrativeSignal,
  type StoryResolvedEvent,
  type StoryTurnRecord,
  upsertStoryNarrativeSignal,
} from "../store/store.ts";

export interface StoryWorldState {
  listCharacters(): StoryCharacter[];
  listThreads(): StoryThread[];
  saveSeed(seed: SeedWorld): void;
  recordTurn(summary: StoryTurnRecord): void;
  recordEvents(events: StoryResolvedEvent[]): void;
  upsertNarrativeSignal(signal: StoryNarrativeSignal): void;
  upsertNarrativeSignals(signals: StoryNarrativeSignal[]): void;
}

export function createStoryWorldState(db: DatabaseSyncInstance): StoryWorldState {
  return {
    listCharacters() {
      return listStoryEntitiesByKind<StoryCharacter>(db, "character");
    },
    listThreads() {
      return listStoryEntitiesByKind<StoryThread>(db, "thread");
    },
    saveSeed(seed) {
      insertStoryEntities(db, seed.characters, "character");
      insertStoryEntities(db, seed.factions, "faction");
      insertStoryEntities(db, seed.locations, "location");
      insertStoryEntities(db, seed.artifacts, "artifact");
      insertStoryEntities(db, seed.threads, "thread");
      insertStoryEntities(db, seed.rules, "rule");

      insertStoryRelation(db, {
        id: "sr-li-yao-knows-su-wan",
        fromId: "c-li-yao",
        relation: "KNOWS",
        toId: "c-su-wan",
        visibility: "public",
      });
      insertStoryRelation(db, {
        id: "sr-li-yao-feels-su-wan",
        fromId: "c-li-yao",
        relation: "FEELS",
        toId: "c-su-wan",
        visibility: "private",
        intensity: 0.6,
      });
      insertStoryRelation(db, {
        id: "sr-ember-seal-owns-shen-mo",
        fromId: "a-ember-seal",
        relation: "OWNS",
        toId: "c-shen-mo",
        visibility: "public",
      });

      upsertStoryNarrativeSignal(db, {
        id: "ns-secret-bloodline",
        kind: "secret",
        subjectId: "c-li-yao",
        relatedId: "t-secret-realm",
        weight: 0.8,
        payloadJson: JSON.stringify({ secret: "ancient-bloodline" }),
        status: "active",
      });
      upsertStoryNarrativeSignal(db, {
        id: "ns-realm-tension",
        kind: "tension",
        subjectId: "f-cloud-sword",
        relatedId: "t-secret-realm",
        weight: 0.7,
        payloadJson: JSON.stringify({ cause: "inheritance-dispute" }),
        status: "active",
      });
    },
    recordTurn(summary) {
      insertStoryTurn(db, summary);
    },
    recordEvents(events) {
      for (const event of events) {
        insertStoryEvent(db, event);
      }
    },
    upsertNarrativeSignal(signal) {
      upsertStoryNarrativeSignal(db, signal);
    },
    upsertNarrativeSignals(signals) {
      for (const signal of signals) {
        upsertStoryNarrativeSignal(db, signal);
      }
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
