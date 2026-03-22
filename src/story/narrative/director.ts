import type { StoryResolvedEvent, StoryNarrativeSignal } from "../../store/store.ts";
import type {
  ChapterSelection as RuntimeChapterSelection,
  NarrativeDirectorInput as RuntimeNarrativeDirectorInput,
  StoryModelClient,
} from "../runtime/model-client.ts";
import type { StoryThread } from "../types.ts";

export interface EnsembleHeatEntry {
  entityId: string;
  heat: number;
}

export interface ChapterSelection {
  id: string;
  score: number;
  primaryPovId: string;
  secondaryPovId?: string;
  eventIds: string[];
  toneTarget: string;
  pacingTarget: string;
  hookTarget: string;
}

export interface NarrativeDirectorInput {
  events: StoryResolvedEvent[];
  activeTensions: StoryNarrativeSignal[];
  activeThreads: StoryThread[];
  ensembleState: EnsembleHeatEntry[];
  recentPovIds: string[];
  model: Pick<StoryModelClient, "rerankChapterFocus">;
}

interface ScoredBundle extends ChapterSelection {
  focus: string;
}

interface EventPayloadShape {
  subjectId?: string;
  objectId?: string;
  observers?: string[];
  threadId?: string;
}

export async function selectChapterFocus(input: NarrativeDirectorInput): Promise<ChapterSelection> {
  const ranked = scoreEventBundles(input)
    .map((bundle) => applyPovRecencyPenalty(bundle, input.recentPovIds))
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    throw new Error("[narrative-director] cannot select chapter focus without events");
  }

  const runtimeCandidates: RuntimeChapterSelection[] = ranked.map((bundle) => ({
    id: bundle.id,
    focus: bundle.focus,
    score: bundle.score,
  }));
  const runtimeContext: RuntimeNarrativeDirectorInput = {
    directorId: "narrative-director",
    activeThreads: input.activeThreads.map((thread) => thread.id),
    notes: `recent-povs:${input.recentPovIds.join(",")}`,
  };
  const reranked = await input.model.rerankChapterFocus(runtimeCandidates, runtimeContext);
  const byId = new Map(ranked.map((bundle) => [bundle.id, bundle]));
  const rerankedBundles = reranked
    .map((candidate) => byId.get(candidate.id))
    .filter((bundle): bundle is ScoredBundle => Boolean(bundle));

  return (rerankedBundles[0] ?? ranked[0]);
}

function scoreEventBundles(input: NarrativeDirectorInput): ScoredBundle[] {
  const events = input.events.filter((event): event is StoryResolvedEvent & { id: string } => typeof event.id === "string");
  if (events.length === 0) return [];

  const heatByEntity = new Map(input.ensembleState.map((entry) => [entry.entityId, entry.heat]));
  const candidatePovIds = collectCandidatePovIds(events, input.ensembleState);
  const activeThreadBonus = input.activeThreads.filter((thread) => thread.status === "active").length * 0.1;

  return candidatePovIds.map((povId) => {
    const scoredEvents = events.map((event) => ({
      event,
      relevance: eventRelevanceForPov(event, povId),
    })).sort((a, b) => b.relevance - a.relevance);

    const chosen = scoredEvents.filter((entry) => entry.relevance > 0).slice(0, 3);
    const selectedEvents = chosen.length > 0 ? chosen : scoredEvents.slice(0, 1);
    const eventIds = selectedEvents.map((entry) => entry.event.id);
    const topEvent = selectedEvents[0]?.event ?? events[0];

    const eventScore = selectedEvents.reduce((sum, entry) => sum + entry.relevance, 0);
    const tensionScore = input.activeTensions.reduce((sum, tension) =>
      sum + tensionRelevanceForPov(tension, povId),
    0);
    const heatScore = heatByEntity.get(povId) ?? 0;
    const score = eventScore + tensionScore + heatScore + activeThreadBonus;

    return {
      id: `focus-${povId}-${eventIds.join("-")}`,
      focus: `${povId}:${topEvent.type}`,
      score,
      primaryPovId: povId,
      secondaryPovId: inferSecondaryPov(topEvent, povId),
      eventIds,
      toneTarget: inferTone(topEvent.type),
      pacingTarget: inferPacing(topEvent.type),
      hookTarget: inferHook(topEvent.summary),
    };
  });
}

function collectCandidatePovIds(events: Array<StoryResolvedEvent & { id: string }>, ensembleState: EnsembleHeatEntry[]) {
  const ids = new Set<string>();
  for (const event of events) {
    const payload = event.payload as EventPayloadShape | null;
    if (payload?.subjectId?.startsWith("c-")) ids.add(payload.subjectId);
    if (payload?.objectId?.startsWith("c-")) ids.add(payload.objectId);
    if (Array.isArray(payload?.observers)) {
      for (const observerId of payload.observers) {
        if (observerId.startsWith("c-")) ids.add(observerId);
      }
    }
  }
  for (const entry of ensembleState) {
    if (entry.entityId.startsWith("c-")) ids.add(entry.entityId);
  }
  return Array.from(ids);
}

function eventRelevanceForPov(event: StoryResolvedEvent & { id: string }, povId: string): number {
  const payload = event.payload as EventPayloadShape | null;
  let relevance = 0;
  if (payload?.subjectId === povId) relevance += 1.2;
  if (payload?.objectId === povId) relevance += 0.9;
  if (Array.isArray(payload?.observers) && payload.observers.includes(povId)) relevance += 0.8;
  if (event.type.includes("conflict")) relevance += 0.4;
  if (event.type.includes("secret")) relevance += 0.4;
  return relevance;
}

function tensionRelevanceForPov(signal: StoryNarrativeSignal, povId: string): number {
  const base = signal.weight ?? 1;
  if (signal.subjectId === povId) return base * 0.8;
  if (signal.relatedId === povId) return base * 0.6;
  return 0;
}

function applyPovRecencyPenalty(bundle: ScoredBundle, recentPovIds: string[]): ScoredBundle {
  const repeats = recentPovIds.filter((povId) => povId === bundle.primaryPovId).length;
  if (repeats === 0) return bundle;
  return {
    ...bundle,
    score: bundle.score - (repeats * 1.5),
  };
}

function inferSecondaryPov(event: StoryResolvedEvent & { id: string }, primaryPovId: string): string | undefined {
  const payload = event.payload as EventPayloadShape | null;
  if (payload?.subjectId && payload.subjectId !== primaryPovId && payload.subjectId.startsWith("c-")) {
    return payload.subjectId;
  }
  if (payload?.objectId && payload.objectId !== primaryPovId && payload.objectId.startsWith("c-")) {
    return payload.objectId;
  }
  return undefined;
}

function inferTone(eventType: string): string {
  if (eventType.includes("secret")) return "intimate revelation";
  if (eventType.includes("conflict")) return "volatile confrontation";
  return "measured cultivation drama";
}

function inferPacing(eventType: string): string {
  if (eventType.includes("conflict")) return "fast escalation";
  if (eventType.includes("secret")) return "tense slow burn";
  return "steady progression";
}

function inferHook(summary: string): string {
  return summary.trim() || "A hidden force shifts at the chapter edge.";
}
