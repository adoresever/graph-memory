import { describe, expect, it } from "vitest";
import { createStoryWorldState } from "../../src/story/world-state.ts";
import { createSeedWorld } from "../../src/story/bootstrap.ts";
import { buildChapterPacket, createAndStoreChapter, generateChapter, type ChapterPacket } from "../../src/story/narrative/chapter-generator.ts";
import type { ChapterSelection } from "../../src/story/narrative/director.ts";
import type { NarrativeDirectorState } from "../../src/story/narrative/state.ts";
import type { StoryTurnResult } from "../../src/story/turn-simulator.ts";
import { insertStoryEvent } from "../../src/store/store.ts";
import { buildStoryModelClientForTest } from "../../src/story/runtime/model-client.ts";
import { createTestDb } from "../helpers.ts";

describe("chapter generator", () => {
  it("generates prose from a bounded chapter packet", async () => {
    const capture = createCapturingChapterModel();
    const output = await generateChapter(capture.model, chapterPacket);
    expect(output.prose.length).toBeGreaterThan(100);
    expect(output.claims.length).toBeGreaterThan(0);
    expect(capture.lastPacket).toBeDefined();
    expect(capture.lastPacket?.focus).toContain("c-li-yao");
    expect(capture.lastPacket?.summary).toContain("\"relationshipHistory\"");
    expect(capture.lastPacket?.summary).toContain("\"unresolvedSecrets\"");
    expect(capture.lastPacket?.summary).toContain("\"activeTensionSummary\"");
    expect(capture.lastPacket?.summary).toContain("\"toneTarget\":\"wuxia intrigue\"");
    expect(capture.lastPacket?.summary).toContain("\"pacingTarget\":\"tight and rising\"");
    expect(capture.lastPacket?.summary).toContain("\"chapterEndHook\":\"the spirit tablet splits open at midnight\"");
  });

  it("assembles a bounded chapter packet from recall and director state", () => {
    const db = createTestDb();
    try {
      const world = createStoryWorldState(db);
      world.saveSeed(createSeedWorld());
      insertStoryEvent(db, {
        id: "sev-12-1",
        turnNumber: 12,
        type: "secret",
        summary: "Li Yao uncovers a hidden inheritance tablet.",
        payload: { threadId: "t-secret-realm", subjectId: "c-li-yao" },
        visibility: "public",
        observers: [],
      });
      insertStoryEvent(db, {
        id: "sev-12-2",
        turnNumber: 12,
        type: "conflict",
        summary: "Sect elders pressure Su Wan over succession.",
        payload: { threadId: "t-secret-realm", subjectId: "c-su-wan" },
        visibility: "public",
        observers: [],
      });

      const turnResult: StoryTurnResult = {
        turnNumber: 12,
        events: [
          {
            id: "sev-12-1",
            turnNumber: 12,
            type: "secret",
            summary: "Li Yao uncovers a hidden inheritance tablet.",
            payload: { threadId: "t-secret-realm", subjectId: "c-li-yao" },
          },
          {
            id: "sev-12-2",
            turnNumber: 12,
            type: "conflict",
            summary: "Sect elders pressure Su Wan over succession.",
            payload: { threadId: "t-secret-realm", subjectId: "c-su-wan" },
          },
        ],
        stateChanges: [
          {
            kind: "relation-upsert",
            fromId: "c-li-yao",
            relation: "DISCOVERS",
            toId: "a-ember-seal",
            sourceEventId: "sev-12-1",
          },
        ],
      };
      const directorState: NarrativeDirectorState = {
        activeThreads: [{ id: "t-secret-realm", name: "Secret Realm", status: "active" }],
        unresolvedSecrets: [],
        activeTensions: [],
        payoffCandidates: [],
        ensembleHeat: [{ entityId: "c-li-yao", heat: 1 }],
        recentPovIds: ["c-su-wan"],
      };
      const chapterSelection: ChapterSelection = {
        id: "focus-c-li-yao-12",
        score: 4.2,
        primaryPovId: "c-li-yao",
        secondaryPovId: "c-su-wan",
        eventIds: ["sev-12-1", "sev-12-2"],
        toneTarget: "brooding revelation",
        pacingTarget: "measured escalation",
        hookTarget: "the inheritance tablet reacts to bloodline qi",
      };

      const packet = buildChapterPacket(db, turnResult, directorState, chapterSelection);
      expect(packet.relationshipHistory.length).toBeGreaterThan(0);
      expect(packet.unresolvedSecrets.length).toBeGreaterThan(0);
      expect(packet.activeTensionSummary.length).toBeGreaterThan(0);
      expect(packet.chapterEndHook).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it("persists chapter prose even when claim extraction fails afterward", async () => {
    const db = createTestDb();
    try {
      const result = await createAndStoreChapter(db, {
        generateChapter: async () => "Persist me before claim extraction fails.",
        extractClaims: async () => {
          throw new Error("claims-failed");
        },
      }, chapterPacket);

      expect(result.prose).toContain("Persist me");
      expect(result.claims).toEqual([]);

      const row = db.prepare(`
        SELECT turn_number, pov_id, prose, claims_json
        FROM story_chapters
        WHERE turn_number = ?
      `).get(chapterPacket.turnNumber) as
        | { turn_number: number; pov_id: string; prose: string; claims_json: string }
        | undefined;
      expect(row).toBeDefined();
      expect(row?.turn_number).toBe(chapterPacket.turnNumber);
      expect(row?.pov_id).toBe(chapterPacket.primaryPovId);
      expect(row?.prose).toContain("Persist me");
      expect(row?.claims_json).toBe("[]");
    } finally {
      db.close();
    }
  });

  it("concrete runtime chapter generation prompt includes packet.summary content", async () => {
    let capturedUserPrompt = "";
    const client = buildStoryModelClientForTest(async (_operation, user) => {
      capturedUserPrompt = user;
      return "Generated chapter prose.";
    });

    await client.generateChapter({
      turnNumber: 99,
      focus: "c-li-yao|events:sev-99-1",
      summary: "{\"marker\":\"summary-propagates\"}",
    });

    expect(capturedUserPrompt).toContain("summary-propagates");
  });
});

const chapterPacket: ChapterPacket = {
  turnNumber: 9,
  primaryPovId: "c-li-yao",
  secondaryPovId: "c-su-wan",
  selectedEvents: [
    {
      id: "sev-9-1",
      turnNumber: 9,
      type: "secret",
      summary: "Li Yao senses the seal pulse beneath the hall.",
      payload: { threadId: "t-secret-realm", subjectId: "c-li-yao" },
    },
  ],
  eventSummaries: ["Li Yao senses the seal pulse beneath the hall."],
  stateDeltas: [
    {
      kind: "relation-upsert",
      fromId: "c-li-yao",
      relation: "SENSES",
      toId: "a-ember-seal",
      sourceEventId: "sev-9-1",
    },
  ],
  relationshipHistory: [
    {
      id: "sr-li-yao-knows-su-wan",
      fromId: "c-li-yao",
      relation: "KNOWS",
      toId: "c-su-wan",
      visibility: "public",
      intensity: 1,
    },
  ],
  unresolvedSecrets: [
    {
      id: "ns-secret-bloodline",
      kind: "secret",
      subjectId: "c-li-yao",
      relatedId: "t-secret-realm",
      weight: 0.8,
      payloadJson: JSON.stringify({ secret: "ancient-bloodline" }),
      status: "active",
    },
  ],
  activeTensionSummary: ["tension: c-li-yao -> t-secret-realm (0.8)"],
  toneTarget: "wuxia intrigue",
  pacingTarget: "tight and rising",
  chapterEndHook: "the spirit tablet splits open at midnight",
};

const fakeModel = {
  generateChapter: async () =>
    "Li Yao stepped beneath the ancestral lanterns and felt the Ember Seal answer like a second heartbeat, "
    + "a rhythm too old for the Cloud Sword elders to name. Su Wan watched from the shadowed corridor, silent and "
    + "tense, while the hall's carved dragons gathered cold light along their scales. The hidden tablet beneath the "
    + "jade floor rose a finger's width, then another, as if responding to bloodline qi that should never have survived. "
    + "When the sect bells began to ring, both disciples understood that secrecy had ended and inheritance had begun.",
  extractClaims: async () => [{
    subjectId: "c-li-yao",
    predicate: "SENSES",
    objectId: "a-ember-seal",
    evidenceSpan: "felt the Ember Seal answer like a second heartbeat",
  }],
};

function createCapturingChapterModel() {
  let lastPacket: { turnNumber: number; focus: string; summary?: string } | undefined;
  return {
    get lastPacket() {
      return lastPacket;
    },
    model: {
      generateChapter: async (packet: { turnNumber: number; focus: string; summary?: string }) => {
        lastPacket = packet;
        return fakeModel.generateChapter();
      },
      extractClaims: fakeModel.extractClaims,
    },
  };
}
