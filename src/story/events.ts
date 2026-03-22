import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { insertStoryRelation, type StoryNarrativeSignal, type StoryResolvedEvent } from "../store/store.ts";
import type { StoryAction } from "./runtime/model-client.ts";

export interface StoryStateChange {
  kind: "relation-upsert";
  fromId: string;
  relation: string;
  toId: string;
  sourceEventId?: string;
}

interface EventPayloadWithBelief {
  subjectId?: string;
  predicate?: string;
  objectId?: string;
  [key: string]: unknown;
}

interface ResolvedActionInput extends StoryAction {
  actorId: string;
  targetArtifactId?: string;
}

export function resolveActionConflicts(actions: StoryAction[], turnNumber: number): StoryResolvedEvent[] {
  const normalizedActions = actions.map((action) => ({
    ...action,
    actorId: inferActorId(action),
    targetArtifactId: inferTargetArtifactId(action),
  }));

  const artifactBuckets = new Map<string, ResolvedActionInput[]>();
  for (const action of normalizedActions) {
    if (!action.targetArtifactId) continue;
    const bucket = artifactBuckets.get(action.targetArtifactId) ?? [];
    bucket.push(action);
    artifactBuckets.set(action.targetArtifactId, bucket);
  }

  const conflictedActorIds = new Set<string>();
  const events: StoryResolvedEvent[] = [];
  let eventOrdinal = 1;

  for (const [artifactId, contenders] of artifactBuckets) {
    if (contenders.length < 2) continue;
    for (const contender of contenders) {
      conflictedActorIds.add(contender.actorId);
    }
    const contenderIds = contenders.map((action) => action.actorId);
    events.push({
      id: `sev-${turnNumber}-${eventOrdinal++}`,
      turnNumber,
      type: "artifact-conflict",
      summary: `${artifactId} becomes the center of a multi-party contest.`,
      payload: {
        artifactId,
        contenderIds,
        subjectId: artifactId,
        predicate: "CONTESTED_BY",
        objectId: contenderIds[0] ?? "unknown",
      },
    });
  }

  for (const action of normalizedActions) {
    if (conflictedActorIds.has(action.actorId)) continue;
    events.push(
      createResolvedEventFromAction(action, turnNumber, eventOrdinal++),
    );
  }

  return events;
}

export function applyResolvedEvents(db: DatabaseSyncInstance, events: StoryResolvedEvent[]): StoryStateChange[] {
  const updates: StoryStateChange[] = [];
  for (const event of events) {
    const payload = event.payload as EventPayloadWithBelief | null;
    if (
      !payload
      || typeof payload.subjectId !== "string"
      || typeof payload.predicate !== "string"
      || typeof payload.objectId !== "string"
    ) {
      continue;
    }
    insertStoryRelation(db, {
      fromId: payload.subjectId,
      relation: payload.predicate,
      toId: payload.objectId,
      visibility: event.visibility ?? "public",
      sourceEventId: event.id,
    });
    updates.push({
      kind: "relation-upsert",
      fromId: payload.subjectId,
      relation: payload.predicate,
      toId: payload.objectId,
      sourceEventId: event.id,
    });
  }
  return updates;
}

export function deriveNarrativeSignalsFromEvents(events: StoryResolvedEvent[]): StoryNarrativeSignal[] {
  return events.map((event, index) => {
    const payload = event.payload as EventPayloadWithBelief | null;
    const subjectId = typeof payload?.subjectId === "string" ? payload.subjectId : "t-secret-realm";
    const relatedId = typeof payload?.objectId === "string" ? payload.objectId : undefined;
    return {
      id: `ns-${event.id ?? `${event.turnNumber}-${index}`}`,
      kind: event.type,
      subjectId,
      relatedId,
      weight: event.type === "artifact-conflict" ? 1 : 0.7,
      payloadJson: JSON.stringify({
        sourceEventId: event.id,
        summary: event.summary,
      }),
      status: "active",
    };
  });
}

export function summarizeResolvedEvents(events: StoryResolvedEvent[]): string {
  if (events.length === 0) return "No major incidents resolved this turn.";
  return events.slice(0, 3).map((event) => event.summary).join(" ");
}

function inferActorId(action: StoryAction): string {
  const [actorId] = action.id.split(":");
  return actorId || "unknown";
}

function inferTargetArtifactId(action: StoryAction): string | undefined {
  if (typeof action.targetArtifactId === "string") return action.targetArtifactId;
  if (action.type === "seek-artifact" || action.type === "fortify-secret-realm") {
    return "a-ember-seal";
  }
  return undefined;
}

function createResolvedEventFromAction(
  action: ResolvedActionInput,
  turnNumber: number,
  eventOrdinal: number,
): StoryResolvedEvent {
  if (action.type === "seek-artifact") {
    return {
      id: `sev-${turnNumber}-${eventOrdinal}`,
      turnNumber,
      type: "artifact-maneuver",
      summary: `${action.actorId} moves to secure the Ember Seal.`,
      payload: {
        artifactId: action.targetArtifactId ?? "a-ember-seal",
        subjectId: action.targetArtifactId ?? "a-ember-seal",
        predicate: "SOUGHT_BY",
        objectId: action.actorId,
      },
    };
  }

  return {
    id: `sev-${turnNumber}-${eventOrdinal}`,
    turnNumber,
    type: action.type,
    summary: action.summary ?? `${action.actorId} executes ${action.type}.`,
    payload: {
      subjectId: action.actorId,
      predicate: "EXECUTES",
      objectId: action.type,
    },
  };
}
