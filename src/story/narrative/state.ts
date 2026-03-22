import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import type { StoryResolvedEvent, StoryNarrativeSignal } from "../../store/store.ts";
import type { StoryTurnResult } from "../turn-simulator.ts";
import type { StoryThread } from "../types.ts";
import type { ChapterSelection, EnsembleHeatEntry } from "./director.ts";

const DIRECTOR_STATE_KEY = "narrative-director";

export interface NarrativeDirectorState {
  activeThreads: StoryThread[];
  unresolvedSecrets: StoryNarrativeSignal[];
  activeTensions: StoryNarrativeSignal[];
  payoffCandidates: StoryNarrativeSignal[];
  ensembleHeat: EnsembleHeatEntry[];
  recentPovIds: string[];
}

interface EventPayloadShape {
  subjectId?: string;
  objectId?: string;
  threadId?: string;
  threadIds?: string[];
}

export function loadDirectorState(db: DatabaseSyncInstance): NarrativeDirectorState {
  const row = db.prepare(`
    SELECT value_json
    FROM story_director_state
    WHERE key = ?
  `).get(DIRECTOR_STATE_KEY) as { value_json: string } | undefined;
  if (row) {
    const snapshot = parseDirectorStateSnapshot(row.value_json);
    if (snapshot) {
      return snapshot;
    }
  }

  return {
    activeThreads: listTrackedThreads(db),
    unresolvedSecrets: listSignalsByKind(db, "secret"),
    activeTensions: listSignalsByKind(db, "tension"),
    payoffCandidates: listSignalsByKind(db, "payoff-candidate"),
    ensembleHeat: listEnsembleHeat(db),
    recentPovIds: listRecentPovs(db),
  };
}

export function saveDirectorState(db: DatabaseSyncInstance, state: NarrativeDirectorState): void {
  upsertDirectorState(db, state);
}

export function updateDirectorStateFromTurn(
  db: DatabaseSyncInstance,
  state: NarrativeDirectorState,
  turnResult: StoryTurnResult,
  selection: ChapterSelection,
): NarrativeDirectorState {
  void db;
  return {
    activeThreads: reconcileActiveThreads(state.activeThreads, turnResult.events),
    unresolvedSecrets: reconcileSignals(state.unresolvedSecrets, turnResult.events, "secret"),
    activeTensions: reconcileSignals(state.activeTensions, turnResult.events, "tension"),
    payoffCandidates: reconcileSignals(state.payoffCandidates, turnResult.events, "payoff-candidate"),
    ensembleHeat: updateEnsembleHeat(state.ensembleHeat, turnResult.events),
    recentPovIds: appendRecentPov(state.recentPovIds, selection.primaryPovId),
  };
}

function listTrackedThreads(db: DatabaseSyncInstance): StoryThread[] {
  const rows = db.prepare(`
    SELECT payload
    FROM story_entities
    WHERE kind = 'thread' AND status = 'active'
    ORDER BY created_at ASC, id ASC
  `).all() as Array<{ payload: string }>;
  const threads: StoryThread[] = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.payload) as StoryThread;
      if (typeof parsed.id === "string" && typeof parsed.name === "string" && typeof parsed.status === "string") {
        threads.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return threads;
}

function listSignalsByKind(db: DatabaseSyncInstance, kind: string): StoryNarrativeSignal[] {
  const rows = db.prepare(`
    SELECT id, kind, subject_id, related_id, weight, payload_json, status, created_at, updated_at
    FROM story_narrative_signals
    WHERE kind = ? AND status = 'active'
    ORDER BY weight DESC, updated_at DESC, id ASC
  `).all(kind) as Array<{
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
  return rows.map((row) => ({
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
}

function listEnsembleHeat(db: DatabaseSyncInstance): EnsembleHeatEntry[] {
  const heat = new Map<string, number>();
  const relationRows = db.prepare(`
    SELECT from_id, to_id, intensity
    FROM story_relations
    ORDER BY updated_at DESC, id ASC
  `).all() as Array<{ from_id: string; to_id: string; intensity: number }>;
  for (const row of relationRows) {
    if (row.from_id.startsWith("c-")) {
      heat.set(row.from_id, (heat.get(row.from_id) ?? 0) + row.intensity);
    }
    if (row.to_id.startsWith("c-")) {
      heat.set(row.to_id, (heat.get(row.to_id) ?? 0) + row.intensity * 0.7);
    }
  }

  const signalRows = db.prepare(`
    SELECT subject_id, related_id, weight
    FROM story_narrative_signals
    WHERE status = 'active'
    ORDER BY updated_at DESC, id ASC
  `).all() as Array<{ subject_id: string; related_id: string | null; weight: number }>;
  for (const row of signalRows) {
    if (row.subject_id.startsWith("c-")) {
      heat.set(row.subject_id, (heat.get(row.subject_id) ?? 0) + row.weight);
    }
    if (row.related_id?.startsWith("c-")) {
      heat.set(row.related_id, (heat.get(row.related_id) ?? 0) + row.weight * 0.5);
    }
  }

  return Array.from(heat.entries())
    .map(([entityId, value]) => ({ entityId, heat: Number(value.toFixed(3)) }))
    .sort((a, b) => b.heat - a.heat || a.entityId.localeCompare(b.entityId));
}

function listRecentPovs(db: DatabaseSyncInstance): string[] {
  const rows = db.prepare(`
    SELECT pov_id
    FROM story_chapters
    ORDER BY created_at DESC, id DESC
    LIMIT 5
  `).all() as Array<{ pov_id: string }>;
  return rows.map((row) => row.pov_id);
}

function upsertDirectorState(db: DatabaseSyncInstance, state: NarrativeDirectorState): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO story_director_state (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(DIRECTOR_STATE_KEY, JSON.stringify(state), now);
}

function reconcileActiveThreads(existingThreads: StoryThread[], events: StoryResolvedEvent[]): StoryThread[] {
  const threadById = new Map(existingThreads.map((thread) => [thread.id, thread]));
  for (const event of events) {
    const payload = event.payload as EventPayloadShape | null;
    if (payload?.threadId && !threadById.has(payload.threadId)) {
      threadById.set(payload.threadId, {
        id: payload.threadId,
        name: `Thread ${payload.threadId}`,
        status: "active",
      });
    }
    if (Array.isArray(payload?.threadIds)) {
      for (const threadId of payload.threadIds) {
        if (!threadById.has(threadId)) {
          threadById.set(threadId, {
            id: threadId,
            name: `Thread ${threadId}`,
            status: "active",
          });
        }
      }
    }
  }
  return Array.from(threadById.values());
}

function reconcileSignals(
  existingSignals: StoryNarrativeSignal[],
  events: StoryResolvedEvent[],
  targetKind: "secret" | "tension" | "payoff-candidate",
): StoryNarrativeSignal[] {
  const signalById = new Map(existingSignals.map((signal) => [signal.id, signal]));
  for (const event of events) {
    if (!eventMatchesSignalKind(event.type, targetKind)) continue;
    const payload = event.payload as EventPayloadShape | null;
    const eventId = event.id ?? `${event.turnNumber}:${event.type}`;
    signalById.set(`ns-${targetKind}-${eventId}`, {
      id: `ns-${targetKind}-${eventId}`,
      kind: targetKind,
      subjectId: payload?.subjectId ?? "t-secret-realm",
      relatedId: payload?.objectId,
      weight: targetKind === "tension" ? 0.9 : 0.7,
      payloadJson: JSON.stringify({ sourceEventId: event.id, summary: event.summary }),
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  return Array.from(signalById.values());
}

function eventMatchesSignalKind(eventType: string, targetKind: "secret" | "tension" | "payoff-candidate"): boolean {
  if (targetKind === "secret") return eventType.includes("secret") || eventType.includes("conceal");
  if (targetKind === "tension") return eventType.includes("conflict") || eventType.includes("dispute");
  return eventType.includes("artifact") || eventType.includes("breakthrough");
}

function updateEnsembleHeat(existingHeat: EnsembleHeatEntry[], events: StoryResolvedEvent[]): EnsembleHeatEntry[] {
  const heatById = new Map(existingHeat.map((entry) => [entry.entityId, entry.heat]));
  for (const event of events) {
    const payload = event.payload as EventPayloadShape | null;
    const participants = [payload?.subjectId, payload?.objectId]
      .filter((id): id is string => Boolean(id && id.startsWith("c-")));
    for (const participantId of participants) {
      heatById.set(participantId, (heatById.get(participantId) ?? 0) + 0.5);
    }
  }
  return Array.from(heatById.entries())
    .map(([entityId, heat]) => ({ entityId, heat: Number(heat.toFixed(3)) }))
    .sort((a, b) => b.heat - a.heat || a.entityId.localeCompare(b.entityId));
}

function appendRecentPov(recentPovIds: string[], nextPovId: string): string[] {
  return [...recentPovIds, nextPovId].slice(-5);
}

function parseDirectorStateSnapshot(rawValue: string): NarrativeDirectorState | null {
  try {
    const parsed = JSON.parse(rawValue) as Partial<NarrativeDirectorState>;
    if (
      !parsed
      || !Array.isArray(parsed.activeThreads)
      || !Array.isArray(parsed.unresolvedSecrets)
      || !Array.isArray(parsed.activeTensions)
      || !Array.isArray(parsed.payoffCandidates)
      || !Array.isArray(parsed.ensembleHeat)
      || !Array.isArray(parsed.recentPovIds)
    ) {
      return null;
    }
    return {
      activeThreads: parsed.activeThreads as StoryThread[],
      unresolvedSecrets: parsed.unresolvedSecrets as StoryNarrativeSignal[],
      activeTensions: parsed.activeTensions as StoryNarrativeSignal[],
      payoffCandidates: parsed.payoffCandidates as StoryNarrativeSignal[],
      ensembleHeat: parsed.ensembleHeat as EnsembleHeatEntry[],
      recentPovIds: parsed.recentPovIds.filter((value): value is string => typeof value === "string"),
    };
  } catch {
    return null;
  }
}
