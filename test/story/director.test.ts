import { describe, expect, it } from "vitest";
import type { StoryResolvedEvent, StoryNarrativeSignal } from "../../src/store/store.ts";
import { selectChapterFocus, type EnsembleHeatEntry } from "../../src/story/narrative/director.ts";
import type { ChapterSelection as RuntimeChapterSelection, NarrativeDirectorInput as RuntimeNarrativeDirectorInput } from "../../src/story/runtime/model-client.ts";
import type { StoryThread } from "../../src/story/types.ts";
import { loadDirectorState, saveDirectorState, type NarrativeDirectorState } from "../../src/story/narrative/state.ts";
import { createTestDb } from "../helpers.ts";

describe("narrative director", () => {
  it("selects a single primary pov and chapter-worthy event bundle", async () => {
    const choice = await selectChapterFocus({
      events: fixtureEvents,
      activeTensions: fixtureTensions,
      activeThreads: fixtureThreads,
      ensembleState: fixtureEnsemble,
      recentPovIds: ["c-li-yao", "c-li-yao"],
      model: fakeDirectorModel(),
    });

    expect(choice.primaryPovId).toBeDefined();
    expect(choice.eventIds.length).toBeGreaterThan(0);
  });

  it("avoids repeating the same pov when recent pov history is saturated", async () => {
    const choice = await selectChapterFocus({
      events: fixtureEvents,
      activeThreads: fixtureThreads,
      activeTensions: fixtureTensions,
      ensembleState: fixtureEnsemble,
      recentPovIds: ["c-li-yao", "c-li-yao", "c-li-yao"],
      model: fakeDirectorModel(),
    });
    expect(choice.primaryPovId).not.toBe("c-li-yao");
  });

  it("does not pick high-heat offstage povs with zero event relevance", async () => {
    const choice = await selectChapterFocus({
      events: fixtureEvents,
      activeThreads: fixtureThreads,
      activeTensions: fixtureTensions,
      ensembleState: [
        ...fixtureEnsemble,
        { entityId: "c-offstage", heat: 100 },
      ],
      recentPovIds: [],
      model: fakeDirectorModel(),
    });

    expect(choice.primaryPovId).not.toBe("c-offstage");
  });

  it("round-trips saved director state snapshots", () => {
    const db = createTestDb();
    try {
      const snapshot: NarrativeDirectorState = {
        activeThreads: [{ id: "t-snapshot", name: "Snapshot Thread", status: "active" }],
        unresolvedSecrets: [{
          id: "ns-snap-secret",
          kind: "secret",
          subjectId: "c-li-yao",
          relatedId: "t-snapshot",
          weight: 1,
          payloadJson: "{\"k\":\"v\"}",
          status: "active",
        }],
        activeTensions: [{
          id: "ns-snap-tension",
          kind: "tension",
          subjectId: "c-su-wan",
          relatedId: "c-shen-mo",
          weight: 0.8,
          payloadJson: "{\"pressure\":true}",
          status: "active",
        }],
        payoffCandidates: [{
          id: "ns-snap-payoff",
          kind: "payoff-candidate",
          subjectId: "a-ember-seal",
          relatedId: "c-li-yao",
          weight: 0.7,
          payloadJson: "{\"arc\":\"seal-awakens\"}",
          status: "active",
        }],
        ensembleHeat: [{ entityId: "c-li-yao", heat: 9 }],
        recentPovIds: ["c-su-wan", "c-li-yao"],
      };
      saveDirectorState(db, snapshot);

      expect(loadDirectorState(db)).toEqual(snapshot);
    } finally {
      db.close();
    }
  });
});

const fixtureEvents: StoryResolvedEvent[] = [
  {
    id: "sev-7-1",
    turnNumber: 7,
    type: "conceal-bloodline",
    summary: "Li Yao hides a bloodline surge from elder scrutiny.",
    payload: { subjectId: "c-li-yao", objectId: "t-secret-realm", threadId: "t-secret-realm" },
  },
  {
    id: "sev-7-2",
    turnNumber: 7,
    type: "artifact-conflict",
    summary: "Su Wan and Shen Mo clash over the Ember Seal's resonance.",
    payload: { subjectId: "c-su-wan", objectId: "c-shen-mo", threadId: "t-secret-realm" },
  },
  {
    id: "sev-7-3",
    turnNumber: 7,
    type: "alliance-gesture",
    summary: "Su Wan offers Li Yao a dangerous alliance.",
    payload: { subjectId: "c-su-wan", objectId: "c-li-yao", threadId: "t-secret-realm" },
  },
];

const fixtureTensions: StoryNarrativeSignal[] = [
  {
    id: "ns-1",
    kind: "tension",
    subjectId: "c-su-wan",
    relatedId: "c-shen-mo",
    weight: 0.9,
    payloadJson: JSON.stringify({ source: "artifact-conflict" }),
    status: "active",
  },
];

const fixtureThreads: StoryThread[] = [
  { id: "t-secret-realm", name: "Secret Realm Inheritance", status: "active" },
];

const fixtureEnsemble: EnsembleHeatEntry[] = [
  { entityId: "c-li-yao", heat: 0.95 },
  { entityId: "c-su-wan", heat: 0.8 },
  { entityId: "c-shen-mo", heat: 0.7 },
];

function fakeDirectorModel() {
  return {
    rerankChapterFocus: async (
      candidates: RuntimeChapterSelection[],
      _context: RuntimeNarrativeDirectorInput,
    ): Promise<RuntimeChapterSelection[]> => candidates,
  };
}
