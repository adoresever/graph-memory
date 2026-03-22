import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { buildRecallPacket } from "../memory/recall.ts";
import type { StoryStateChange } from "../events.ts";
import type { StoryModelClient, StoryClaim } from "../runtime/model-client.ts";
import type { StoryTurnResult } from "../turn-simulator.ts";
import type { StoryNarrativeSignal, StoryResolvedEvent, StoryStoredRelation } from "../../store/store.ts";
import type { ChapterSelection } from "./director.ts";
import type { NarrativeDirectorState } from "./state.ts";

export interface ChapterPacket {
  turnNumber: number;
  primaryPovId: string;
  secondaryPovId?: string;
  selectedEvents: StoryResolvedEvent[];
  eventSummaries: string[];
  stateDeltas: StoryStateChange[];
  relationshipHistory: StoryStoredRelation[];
  unresolvedSecrets: StoryNarrativeSignal[];
  activeTensionSummary: string[];
  toneTarget: string;
  pacingTarget: string;
  chapterEndHook: string;
}

export interface GeneratedChapterOutput {
  prose: string;
  summary: string;
  claims: StoryClaim[];
}

export function buildChapterPacket(
  db: DatabaseSyncInstance,
  turnResult: StoryTurnResult,
  directorState: NarrativeDirectorState,
  selection: ChapterSelection,
): ChapterPacket {
  const selectedEvents = turnResult.events.filter((event) => event.id && selection.eventIds.includes(event.id));
  const recall = buildRecallPacket(db, { povId: selection.primaryPovId, eventIds: selection.eventIds });
  const tensionSource = recall.activeTensions.length > 0 ? recall.activeTensions : directorState.activeTensions;

  return {
    turnNumber: turnResult.turnNumber,
    primaryPovId: selection.primaryPovId,
    secondaryPovId: selection.secondaryPovId,
    selectedEvents,
    eventSummaries: selectedEvents.map((event) => event.summary),
    stateDeltas: turnResult.stateChanges
      .filter((delta) => delta.sourceEventId && selection.eventIds.includes(delta.sourceEventId)),
    relationshipHistory: recall.relationships,
    unresolvedSecrets: recall.unresolvedSecrets.length > 0 ? recall.unresolvedSecrets : directorState.unresolvedSecrets,
    activeTensionSummary: summarizeSignals(tensionSource),
    toneTarget: selection.toneTarget,
    pacingTarget: selection.pacingTarget,
    chapterEndHook: selection.hookTarget,
  };
}

export async function generateChapter(
  model: Pick<StoryModelClient, "generateChapter" | "extractClaims">,
  packet: ChapterPacket,
): Promise<GeneratedChapterOutput> {
  const runtimePacket = toRuntimeChapterPacket(packet);
  const prose = await model.generateChapter(runtimePacket);
  return {
    prose,
    summary: summarizeChapter(packet),
    claims: await extractChapterClaims(model, prose),
  };
}

export async function createAndStoreChapter(
  db: DatabaseSyncInstance,
  model: Pick<StoryModelClient, "generateChapter" | "extractClaims">,
  packet: ChapterPacket,
): Promise<GeneratedChapterOutput> {
  const chapter = await generateChapter(model, packet);
  db.prepare(`
    INSERT INTO story_chapters (id, turn_number, pov_id, summary, prose, claims_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    chapterId(packet.turnNumber),
    packet.turnNumber,
    packet.primaryPovId,
    chapter.summary,
    chapter.prose,
    JSON.stringify(chapter.claims),
    Date.now(),
  );
  return chapter;
}

export function summarizeSignals(signals: StoryNarrativeSignal[]): string[] {
  if (signals.length === 0) return ["No active tensions surfaced for this POV."];
  return signals.slice(0, 3).map((signal) =>
    `${signal.kind}: ${signal.subjectId} -> ${signal.relatedId ?? "unknown"} (${signal.weight ?? 1})`
  );
}

function summarizeChapter(packet: ChapterPacket): string {
  const lead = packet.eventSummaries.slice(0, 2).join(" ");
  return `${lead} Hook: ${packet.chapterEndHook}`;
}

function toRuntimeChapterPacket(packet: ChapterPacket): { turnNumber: number; focus: string; summary: string } {
  const eventIds = packet.selectedEvents
    .map((event) => event.id)
    .filter((id): id is string => typeof id === "string");
  const focus = `${packet.primaryPovId}|events:${eventIds.join(",") || "none"}|secondary:${packet.secondaryPovId ?? "none"}`;
  const summary = JSON.stringify({
    eventSummaries: packet.eventSummaries,
    stateDeltas: packet.stateDeltas,
    relationshipHistory: packet.relationshipHistory,
    unresolvedSecrets: packet.unresolvedSecrets,
    activeTensionSummary: packet.activeTensionSummary,
    toneTarget: packet.toneTarget,
    pacingTarget: packet.pacingTarget,
    chapterEndHook: packet.chapterEndHook,
  });
  return {
    turnNumber: packet.turnNumber,
    focus,
    summary,
  };
}

async function extractChapterClaims(
  model: Pick<StoryModelClient, "extractClaims">,
  prose: string,
): Promise<StoryClaim[]> {
  return model.extractClaims(prose);
}

function chapterId(turnNumber: number): string {
  return `sch-${turnNumber}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
