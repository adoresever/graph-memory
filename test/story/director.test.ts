import { describe, expect, it } from "vitest";
import type { StoryResolvedEvent, StoryNarrativeSignal } from "../../src/store/store.ts";
import { selectChapterFocus, type EnsembleHeatEntry } from "../../src/story/narrative/director.ts";
import type { StoryThread } from "../../src/story/types.ts";

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
    rerankChapterFocus: async (candidates: Array<{ id: string }>) => candidates,
  };
}
