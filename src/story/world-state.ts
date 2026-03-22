import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { createSeedWorld } from "./bootstrap.ts";
import type { SeedWorld, StoryCharacter, StoryThread } from "./types.ts";
import { propagateBeliefsFromEvents } from "./beliefs.ts";
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
  recordTurn(turn: StoryTurnRecord): void;
  recordEvents(events: StoryResolvedEvent[]): void;
  recordChapter(chapter: {
    turnNumber: number;
    povId: string;
    summary: string;
    prose: string;
    claimsJson: string;
  }): void;
  saveDirectorStateSnapshot(key: string, valueJson: string): void;
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
      const presentIds = new Set<string>([
        ...seed.characters.map((entity) => entity.id),
        ...seed.factions.map((entity) => entity.id),
        ...seed.locations.map((entity) => entity.id),
        ...seed.artifacts.map((entity) => entity.id),
        ...seed.threads.map((entity) => entity.id),
        ...seed.rules.map((entity) => entity.id),
      ]);
      const canonicalRelations = [
        {
          id: "sr-li-yao-knows-su-wan",
          fromId: "c-li-yao",
          relation: "KNOWS",
          toId: "c-su-wan",
          visibility: "public",
        },
        {
          id: "sr-li-yao-feels-su-wan",
          fromId: "c-li-yao",
          relation: "FEELS",
          toId: "c-su-wan",
          visibility: "private",
          intensity: 0.6,
        },
        {
          id: "sr-ember-seal-owns-shen-mo",
          fromId: "a-ember-seal",
          relation: "OWNS",
          toId: "c-shen-mo",
          visibility: "public",
        },
      ].filter((relation) => presentIds.has(relation.fromId) && presentIds.has(relation.toId));
      const canonicalSignals = [
        {
          id: "ns-secret-bloodline",
          kind: "secret",
          subjectId: "c-li-yao",
          relatedId: "t-secret-realm",
          weight: 0.8,
          payloadJson: JSON.stringify({ secret: "ancient-bloodline" }),
          status: "active",
        },
        {
          id: "ns-realm-tension",
          kind: "tension",
          subjectId: "f-cloud-sword",
          relatedId: "t-secret-realm",
          weight: 0.7,
          payloadJson: JSON.stringify({ cause: "inheritance-dispute" }),
          status: "active",
        },
      ].filter((signal) => {
        const hasSubject = presentIds.has(signal.subjectId);
        const hasRelated = signal.relatedId ? presentIds.has(signal.relatedId) : true;
        return hasSubject && hasRelated;
      });

      db.exec("BEGIN");
      try {
        insertStoryEntities(db, seed.characters, "character");
        insertStoryEntities(db, seed.factions, "faction");
        insertStoryEntities(db, seed.locations, "location");
        insertStoryEntities(db, seed.artifacts, "artifact");
        insertStoryEntities(db, seed.threads, "thread");
        insertStoryEntities(db, seed.rules, "rule");

        for (const relation of canonicalRelations) {
          insertStoryRelation(db, relation);
        }
        for (const signal of canonicalSignals) {
          upsertStoryNarrativeSignal(db, signal);
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    recordTurn(turn) {
      insertStoryTurn(db, turn);
    },
    recordEvents(events) {
      db.exec("BEGIN");
      try {
        for (const event of events) {
          insertStoryEvent(db, event);
        }
        propagateBeliefsFromEvents(db, events);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    recordChapter(chapter) {
      db.prepare(`
        INSERT INTO story_chapters (id, turn_number, pov_id, summary, prose, claims_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        `sch-${chapter.turnNumber}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        chapter.turnNumber,
        chapter.povId,
        chapter.summary,
        chapter.prose,
        chapter.claimsJson,
        Date.now(),
      );
    },
    saveDirectorStateSnapshot(key, valueJson) {
      db.prepare(`
        INSERT INTO story_director_state (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `).run(key, valueJson, Date.now());
    },
    upsertNarrativeSignal(signal) {
      upsertStoryNarrativeSignal(db, signal);
    },
    upsertNarrativeSignals(signals) {
      db.exec("BEGIN");
      try {
        for (const signal of signals) {
          upsertStoryNarrativeSignal(db, signal);
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

export function initializeStoryWorld(db: DatabaseSyncInstance): StoryWorldState {
  const world = createStoryWorldState(db);
  if (world.listCharacters().length === 0) {
    world.saveSeed(createSeedWorld());
  } else if (countActiveNarrativeSignals(db) === 0) {
    for (const signal of listCanonicalNarrativeSignals(listPresentEntityIds(db))) {
      world.upsertNarrativeSignal(signal);
    }
  }
  return world;
}

function listCanonicalNarrativeSignals(presentIds: Set<string>) {
  return [
    {
      id: "ns-secret-bloodline",
      kind: "secret",
      subjectId: "c-li-yao",
      relatedId: "t-secret-realm",
      weight: 0.8,
      payloadJson: JSON.stringify({ secret: "ancient-bloodline" }),
      status: "active",
    },
    {
      id: "ns-realm-tension",
      kind: "tension",
      subjectId: "f-cloud-sword",
      relatedId: "t-secret-realm",
      weight: 0.7,
      payloadJson: JSON.stringify({ cause: "inheritance-dispute" }),
      status: "active",
    },
  ].filter((signal) => {
    const hasSubject = presentIds.has(signal.subjectId);
    const hasRelated = signal.relatedId ? presentIds.has(signal.relatedId) : true;
    return hasSubject && hasRelated;
  });
}

function listPresentEntityIds(db: DatabaseSyncInstance): Set<string> {
  const kinds = ["character", "faction", "location", "artifact", "thread", "rule"] as const;
  return new Set<string>(
    kinds.flatMap((kind) =>
      listStoryEntitiesByKind<{ id: string }>(db, kind).map((entity) => entity.id)
    ),
  );
}

function countActiveNarrativeSignals(db: DatabaseSyncInstance): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM story_narrative_signals
    WHERE status = 'active'
  `).get() as { count: number } | undefined;
  return row?.count ?? 0;
}
