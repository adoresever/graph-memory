import type { SeedWorld } from "./types.ts";

export function createSeedWorld(): SeedWorld {
  return {
    characters: [
      {
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
      },
      {
        id: "c-shen-mo",
        name: "Shen Mo",
        realm: "Core",
        coreDesires: ["control-sect"],
        shortTermGoals: ["purge-rivals"],
        taboos: ["lose-face"],
        resources: { spiritStones: 900, reputation: 80 },
        hiddenTruths: ["stole-inheritance-clue"],
        emotionalVectors: { "c-li-yao": -0.6 },
        publicIdentity: "orthodox elder",
        privateIdentity: "inheritance usurper",
      },
      {
        id: "c-su-wan",
        name: "Su Wan",
        realm: "Foundation",
        coreDesires: ["protect-clan"],
        shortTermGoals: ["recover-artifact"],
        taboos: ["abandon-family"],
        resources: { spiritStones: 120, reputation: 35 },
        hiddenTruths: ["knows-ember-seal-history"],
        emotionalVectors: { "c-li-yao": 0.7 },
        publicIdentity: "quiet disciple",
        privateIdentity: "last clan witness",
      },
    ],
    factions: [
      {
        id: "f-cloud-sword",
        name: "Cloud Sword Sect",
        agenda: ["preserve-orthodoxy", "control-secret-realm"],
        constraints: ["inheritance-dispute"],
        doctrine: "order-before-truth",
        internalBlocks: ["elder-lineage-rivalry"],
        strategicTargets: ["a-ember-seal"],
        publicPosture: "righteous-sect",
        hiddenOperations: ["surveil-disciples"],
      },
      {
        id: "f-black-river",
        name: "Black River Hall",
        agenda: ["steal-artifacts", "destabilize-rivals"],
        constraints: ["resource-shortage"],
        doctrine: "profit-through-chaos",
        internalBlocks: ["masked-envoy-faction"],
        strategicTargets: ["l-fallen-realm"],
        publicPosture: "neutral-traders",
        hiddenOperations: ["seed-rumors"],
      },
    ],
    locations: [
      { id: "l-cloud-peak", name: "Cloud Peak", kind: "sect" },
      { id: "l-fallen-realm", name: "Fallen Ember Secret Realm", kind: "secret-realm" },
    ],
    artifacts: [
      { id: "a-ember-seal", name: "Ember Seal", kind: "inheritance-token", ownerId: "c-shen-mo" },
    ],
    threads: [
      { id: "t-secret-realm", name: "Secret realm inheritance struggle", status: "active" },
    ],
    rules: [
      { id: "r-secrecy", name: "bloodline secrecy taboo", effect: "exposure-triggers-pursuit" },
    ],
    tone: {
      genre: "xianxia",
      mood: "tense and fate-driven",
      proseStyle: "elevated but readable",
    },
  };
}
