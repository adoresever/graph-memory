import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import type { StoryCharacter, StoryFaction } from "./types.ts";
import { rankActorActions } from "./decision/actor-engine.ts";
import { rankFactionActions } from "./decision/faction-engine.ts";
import { createStoryWorldState } from "./world-state.ts";
import {
  listStoryBeliefsForActor,
  listStoryEntitiesByKind,
  type StoryBelief,
  type StoryNarrativeSignal,
  type StoryResolvedEvent,
} from "../store/store.ts";
import type { StoryModelClient } from "./runtime/model-client.ts";
import {
  applyResolvedEvents,
  deriveNarrativeSignalsFromEvents,
  resolveActionConflicts,
  summarizeResolvedEvents,
  type StoryStateChange,
} from "./events.ts";

export interface StoryTurnInput {
  turnNumber: number;
  model: Pick<StoryModelClient, "rerankActorActions" | "rerankFactionActions">;
}

export interface StoryTurnResult {
  turnNumber: number;
  events: StoryResolvedEvent[];
  stateChanges: StoryStateChange[];
}

interface SettledWorldState {
  actors: StoryCharacter[];
  factions: StoryFaction[];
  beliefsByActor: Record<string, StoryBelief[]>;
  beliefsByFaction: Record<string, StoryBelief[]>;
  worldSignals: StoryNarrativeSignal[];
}

export async function runStoryTurn(db: DatabaseSyncInstance, input: StoryTurnInput): Promise<StoryTurnResult> {
  const settlement = settleWorldState(db);
  const actorActions = (await Promise.all(settlement.actors.map((actor) =>
    rankActorActions({
      actor,
      beliefs: settlement.beliefsByActor[actor.id] ?? [],
      worldSignals: settlement.worldSignals,
      model: input.model,
    })
  ))).flat();
  const factionActions = (await Promise.all(settlement.factions.map((faction) =>
    rankFactionActions({
      faction,
      beliefs: settlement.beliefsByFaction[faction.id] ?? [],
      worldSignals: settlement.worldSignals,
      model: input.model,
    })
  ))).flat();

  const events = resolveActionConflicts([...actorActions, ...factionActions], input.turnNumber);
  const updates = applyResolvedEvents(db, events);
  const narrativeSignals = deriveNarrativeSignalsFromEvents(events);
  const world = createStoryWorldState(db);

  world.recordTurn({
    turnNumber: input.turnNumber,
    summary: summarizeResolvedEvents(events),
    payload: { events, stateChanges: updates },
  });
  world.recordEvents(events);
  world.upsertNarrativeSignals(narrativeSignals);

  return { turnNumber: input.turnNumber, events, stateChanges: updates };
}

function settleWorldState(db: DatabaseSyncInstance): SettledWorldState {
  const actors = listStoryEntitiesByKind<StoryCharacter>(db, "character");
  const factions = listStoryEntitiesByKind<StoryFaction>(db, "faction");
  const beliefsByActor = Object.fromEntries(
    actors.map((actor) => [actor.id, listStoryBeliefsForActor(db, actor.id)]),
  );
  const beliefsByFaction = Object.fromEntries(
    factions.map((faction) => [faction.id, listStoryBeliefsForActor(db, faction.id)]),
  );

  const rows = db.prepare(`
    SELECT id, kind, subject_id, related_id, weight, payload_json, status, created_at, updated_at
    FROM story_narrative_signals
    WHERE status = 'active'
    ORDER BY weight DESC, updated_at DESC, id ASC
  `).all() as Array<{
    id: string;
    kind: string;
    subject_id: string;
    related_id: string | null;
    weight: number;
    payload_json: string;
    status: string;
    created_at: number;
    updated_at: number;
  }>;
  const worldSignals = rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    subjectId: row.subject_id,
    relatedId: row.related_id ?? undefined,
    weight: row.weight,
    payloadJson: row.payload_json,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  return { actors, factions, beliefsByActor, beliefsByFaction, worldSignals };
}
