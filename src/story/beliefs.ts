import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import {
  insertStoryRelation,
  listObservableActors,
  listObservableFactions,
  listStoryBeliefsForActor,
  type StoryBelief,
  type StoryResolvedEvent,
  upsertStoryBelief,
} from "../store/store.ts";

interface BeliefEventPayload {
  subjectId: string;
  predicate: string;
  objectId: string;
  confidence?: number;
}

export interface StoryBeliefRepository {
  upsertBelief(belief: StoryBelief): StoryBelief;
  recordRelation(fromId: string, relation: string, toId: string): { fromId: string; relation: string; toId: string };
}

function inferActorKind(actorId: string): "character" | "faction" {
  return actorId.startsWith("f-") ? "faction" : "character";
}

export function createStoryBeliefRepository(db: DatabaseSyncInstance): StoryBeliefRepository {
  return {
    upsertBelief(belief) {
      return upsertStoryBelief(db, belief);
    },
    recordRelation(fromId, relation, toId) {
      insertStoryRelation(db, { fromId, relation, toId, visibility: "public" });
      return { fromId, relation, toId };
    },
  };
}

export function listBeliefsForActor(db: DatabaseSyncInstance, actorId: string): StoryBelief[] {
  return listStoryBeliefsForActor(db, actorId);
}

export function upsertBeliefFromEvent(db: DatabaseSyncInstance, actorId: string, event: StoryResolvedEvent): void {
  const payload = event.payload as BeliefEventPayload | null;
  if (!payload?.subjectId || !payload?.predicate || !payload?.objectId) return;

  upsertStoryBelief(db, {
    actorId,
    actorKind: inferActorKind(actorId),
    subjectId: payload.subjectId,
    predicate: payload.predicate,
    objectId: payload.objectId,
    confidence: payload.confidence ?? 0.75,
  });
}

export function propagateBeliefsFromEvents(db: DatabaseSyncInstance, events: StoryResolvedEvent[]): void {
  for (const event of events) {
    const observers = event.visibility !== "private"
      ? [...listObservableActors(db), ...listObservableFactions(db)]
      : (event.observers ?? []);
    for (const actorId of observers) {
      upsertBeliefFromEvent(db, actorId, event);
    }
  }
}
