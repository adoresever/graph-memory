import { describe, expect, it } from "vitest";
import type { StoryCharacter, StoryFaction } from "../../src/story/types.ts";
import type { StoryBelief, StoryNarrativeSignal } from "../../src/store/store.ts";
import { rankActorActions } from "../../src/story/decision/actor-engine.ts";
import { rankFactionActions } from "../../src/story/decision/faction-engine.ts";

function fakeDecisionModel() {
  return {
    rerankActorActions: async (actions: Array<Record<string, unknown>>) => actions,
    rerankFactionActions: async (actions: Array<Record<string, unknown>>) => actions,
  };
}

describe("story decision engines", () => {
  it("ranks actor actions using desires, goals, and beliefs", async () => {
    const liYao: StoryCharacter = {
      id: "c-li-yao",
      name: "Li Yao",
      realm: "Foundation",
      coreDesires: ["survive", "ascend"],
      shortTermGoals: ["hide-bloodline"],
      taboos: ["betray-master"],
      resources: { spiritStones: 40, reputation: 10 },
      hiddenTruths: ["ancient-bloodline"],
      emotionalVectors: { "c-su-wan": 0.6, "c-shen-mo": -0.4 },
      publicIdentity: "outer-sect disciple",
      privateIdentity: "sealed heir",
    };
    const artifactBelief: StoryBelief = {
      actorId: "c-li-yao",
      actorKind: "character",
      subjectId: "a-ember-seal",
      predicate: "ARTIFACT_CLUE",
      objectId: "l-fallen-realm",
      confidence: 0.9,
    };
    const secretRealmOpening: StoryNarrativeSignal = {
      id: "ns-realm-open",
      kind: "realm-opening",
      subjectId: "t-secret-realm",
      relatedId: "l-fallen-realm",
      weight: 0.8,
      payloadJson: JSON.stringify({ urgency: "high" }),
      status: "active",
    };

    const actions = await rankActorActions({
      actor: liYao,
      beliefs: [artifactBelief],
      worldSignals: [secretRealmOpening],
      model: fakeDecisionModel(),
    });

    expect(actions[0]?.type).toBe("seek-artifact");
  });

  it("ranks faction actions using agenda, beliefs, and constraints", async () => {
    const sect: StoryFaction = {
      id: "f-cloud-sword",
      name: "Cloud Sword Sect",
      agenda: ["preserve-orthodoxy", "control-secret-realm"],
      constraints: ["inheritance-dispute"],
      doctrine: "order-before-truth",
      internalBlocks: ["elder-lineage-rivalry"],
      strategicTargets: ["a-ember-seal"],
      publicPosture: "righteous-sect",
      hiddenOperations: ["surveil-disciples"],
    };
    const factionBelief: StoryBelief = {
      actorId: "f-cloud-sword",
      actorKind: "faction",
      subjectId: "c-shen-mo",
      predicate: "RIVAL_LINEAGE_ACTIVE",
      objectId: "t-secret-realm",
      confidence: 0.85,
    };
    const rivalInheritanceRumor: StoryNarrativeSignal = {
      id: "ns-rival-rumor",
      kind: "inheritance-rumor",
      subjectId: "t-secret-realm",
      relatedId: "c-shen-mo",
      weight: 0.9,
      payloadJson: JSON.stringify({ threat: "lineage-challenge" }),
      status: "active",
    };

    const actions = await rankFactionActions({
      faction: sect,
      beliefs: [factionBelief],
      worldSignals: [rivalInheritanceRumor],
      model: fakeDecisionModel(),
    });

    expect(actions[0]?.type).toBe("purge-rival-line");
  });
});
