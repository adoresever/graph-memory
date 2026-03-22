export interface StoryCharacter {
  id: string;
  name: string;
  realm: string;
  coreDesires: string[];
  shortTermGoals: string[];
  taboos: string[];
  resources: Record<string, number>;
  hiddenTruths: string[];
  emotionalVectors: Record<string, number>;
  publicIdentity: string;
  privateIdentity: string;
}

export interface StoryFaction {
  id: string;
  name: string;
  agenda: string[];
  constraints: string[];
  doctrine: string;
  internalBlocks: string[];
  strategicTargets: string[];
  publicPosture: string;
  hiddenOperations: string[];
}

export interface StoryLocation {
  id: string;
  name: string;
  kind: string;
}

export interface StoryArtifact {
  id: string;
  name: string;
  kind: string;
  ownerId?: string;
}

export interface StoryThread {
  id: string;
  name: string;
  status: "active" | "paused" | "resolved";
}

export interface StoryRule {
  id: string;
  name: string;
  effect: string;
}

export interface SeedWorld {
  characters: StoryCharacter[];
  factions: StoryFaction[];
  locations: StoryLocation[];
  artifacts: StoryArtifact[];
  threads: StoryThread[];
  rules: StoryRule[];
  tone: {
    genre: "xianxia";
    mood: string;
    proseStyle: string;
  };
}
