import { describe, expect, it } from "vitest";
import type { StoryCharacter, StoryFaction } from "../../src/story/types.ts";
import type { StoryBelief, StoryNarrativeSignal } from "../../src/store/store.ts";
import { rankActorActions } from "../../src/story/decision/actor-engine.ts";
import { rankFactionActions } from "../../src/story/decision/faction-engine.ts";

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

    let actorRerankCalls = 0;
    let actorModelInput: Array<Record<string, unknown>> = [];
    const actions = await rankActorActions({
      actor: liYao,
      beliefs: [artifactBelief],
      worldSignals: [secretRealmOpening],
      model: {
        rerankActorActions: async (candidateActions) => {
          actorRerankCalls += 1;
          actorModelInput = candidateActions as Array<Record<string, unknown>>;
          const byType = new Map(candidateActions.map((action) => [action.type, action]));
          return [
            byType.get("conceal-bloodline"),
            byType.get("train-breakthrough"),
            byType.get("seek-artifact"),
          ].filter((action): action is NonNullable<typeof action> => Boolean(action));
        },
        rerankFactionActions: async (candidateActions) => candidateActions,
      },
    });

    expect(actorRerankCalls).toBe(1);
    expect(actorModelInput).toHaveLength(3);
    expect(actorModelInput[0]?.type).toBe("seek-artifact");
    expect(actions).toHaveLength(2);
    expect(actions.map((action) => action.type)).toEqual(["conceal-bloodline", "train-breakthrough"]);
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

    let factionRerankCalls = 0;
    let factionModelInput: Array<Record<string, unknown>> = [];
    const actions = await rankFactionActions({
      faction: sect,
      beliefs: [factionBelief],
      worldSignals: [rivalInheritanceRumor],
      model: {
        rerankActorActions: async (candidateActions) => candidateActions,
        rerankFactionActions: async (candidateActions) => {
          factionRerankCalls += 1;
          factionModelInput = candidateActions as Array<Record<string, unknown>>;
          const byType = new Map(candidateActions.map((action) => [action.type, action]));
          return [
            byType.get("fortify-secret-realm"),
            byType.get("mediate-inheritance-dispute"),
            byType.get("purge-rival-line"),
          ].filter((action): action is NonNullable<typeof action> => Boolean(action));
        },
      },
    });

    expect(factionRerankCalls).toBe(1);
    expect(factionModelInput).toHaveLength(3);
    expect(factionModelInput[0]?.type).toBe("purge-rival-line");
    expect(actions).toHaveLength(2);
    expect(actions.map((action) => action.type)).toEqual(["fortify-secret-realm", "mediate-inheritance-dispute"]);
  });
});
