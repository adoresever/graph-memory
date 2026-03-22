# World-Sim Xianxia MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working closed loop of a xianxia world simulation system that persists world state, advances turns, recalls relevant history, and emits both structured world logs and chapter prose on a fixed cadence.

**Architecture:** Keep the existing `graph-memory` repository as the storage and retrieval foundation, but add a parallel `src/story/` runtime that is independent from the OpenClaw plugin lifecycle. The MVP should use a mixed heuristic-plus-model approach: deterministic state and simulation rules for persistence and turn resolution, with structured model calls for narrative packaging and chapter prose generation.

**Tech Stack:** TypeScript, Node.js 22, `@photostructure/sqlite`, Vitest, fetch-based model clients, existing graph ranking and recall utilities where reusable

---

## File Structure

### New runtime files

- Create: `src/story/config.ts`
- Create: `src/story/types.ts`
- Create: `src/story/bootstrap.ts`
- Create: `src/story/world-state.ts`
- Create: `src/story/beliefs.ts`
- Create: `src/story/decision/actor-engine.ts`
- Create: `src/story/decision/faction-engine.ts`
- Create: `src/story/events.ts`
- Create: `src/story/turn-simulator.ts`
- Create: `src/story/memory/recall.ts`
- Create: `src/story/memory/consistency.ts`
- Create: `src/story/narrative/director.ts`
- Create: `src/story/narrative/chapter-generator.ts`
- Create: `src/story/narrative/state.ts`
- Create: `src/story/runtime/model-client.ts`
- Create: `src/story/runtime/run-loop.ts`
- Create: `src/story/cli.ts`

### Existing files to extend

- Modify: `src/store/db.ts`
- Modify: `src/store/store.ts`
- Modify: `src/engine/llm.ts`
- Modify: `src/types.ts`
- Modify: `package.json`
- Modify: `README.md`

### New test files

- Create: `test/story/bootstrap.test.ts`
- Create: `test/story/world-state.test.ts`
- Create: `test/story/beliefs.test.ts`
- Create: `test/story/decision.test.ts`
- Create: `test/story/turn-simulator.test.ts`
- Create: `test/story/memory-recall.test.ts`
- Create: `test/story/consistency.test.ts`
- Create: `test/story/director.test.ts`
- Create: `test/story/chapter-generator.test.ts`
- Create: `test/story/run-loop.test.ts`
- Create: `test/story/cli.test.ts`
- Create: `test/story/long-run.test.ts`

### Supporting test updates

- Modify: `test/helpers.ts`

## Runtime Configuration

The implementation should treat model configuration as runtime-only and never commit secrets.

Recommended environment variables:

- `NOVEL_LLM_MODE=anthropic-compatible`
- `NOVEL_LLM_BASE_URL=https://api.minimaxi.com/anthropic`
- `NOVEL_LLM_MODEL=MiniMax-M2.7`
- `NOVEL_LLM_API_KEY` set in the shell or `.env`, never committed
- `NOVEL_DB_PATH=~/.graph-memory/story-memory.db`

The plan should not store the actual key in source, tests, docs, or committed fixtures.

## Task 1: Add Story Runtime Scaffolding and Config

**Files:**
- Create: `src/story/config.ts`
- Create: `src/story/cli.ts`
- Create: `src/story/runtime/model-client.ts`
- Modify: `src/engine/llm.ts`
- Modify: `package.json`
- Test: `test/story/bootstrap.test.ts`

- [ ] **Step 1: Write the failing config/bootstrap tests**

```ts
import { describe, expect, it } from "vitest";
import { loadStoryConfig } from "../../src/story/config.ts";

describe("loadStoryConfig", () => {
  it("loads anthropic-compatible runtime settings from env", () => {
    process.env.NOVEL_LLM_MODE = "anthropic-compatible";
    process.env.NOVEL_LLM_BASE_URL = "https://api.minimaxi.com/anthropic";
    process.env.NOVEL_LLM_MODEL = "MiniMax-M2.7";
    process.env.NOVEL_LLM_API_KEY = "test-key";

    const cfg = loadStoryConfig();
    expect(cfg.llm.mode).toBe("anthropic-compatible");
    expect(cfg.llm.baseURL).toContain("minimaxi");
    expect(cfg.llm.model).toBe("MiniMax-M2.7");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/story/bootstrap.test.ts`
Expected: FAIL because `src/story/config.ts` does not exist yet.

- [ ] **Step 3: Implement minimal config and model-client scaffolding**

```ts
export interface StoryRuntimeConfig {
  dbPath: string;
  llm: {
    mode: "openai-compatible" | "anthropic-compatible";
    baseURL: string;
    model: string;
    apiKey: string;
  };
  chapterEveryTurns: number;
  resetOnStart: boolean;
}

export function loadStoryConfig(): StoryRuntimeConfig {
  return {
    dbPath: process.env.NOVEL_DB_PATH ?? "~/.graph-memory/story-memory.db",
    llm: {
      mode: (process.env.NOVEL_LLM_MODE as StoryRuntimeConfig["llm"]["mode"]) ?? "anthropic-compatible",
      baseURL: process.env.NOVEL_LLM_BASE_URL ?? "",
      model: process.env.NOVEL_LLM_MODEL ?? "MiniMax-M2.7",
      apiKey: process.env.NOVEL_LLM_API_KEY ?? "",
    },
    chapterEveryTurns: Number(process.env.NOVEL_CHAPTER_EVERY_TURNS ?? 3),
    resetOnStart: process.env.NOVEL_RESET_ON_START === "1",
  };
}
```

- [ ] **Step 4: Add CLI script entry points**

Add the missing runtime and test dependencies first:

```json
{
  "devDependencies": {
    "tsx": "^4.19.0",
    "execa": "^9.5.2"
  }
}
```

```json
{
  "scripts": {
    "story:run": "node --import tsx src/story/cli.ts",
    "test:story": "vitest run test/story",
    "test:story:cli": "vitest run test/story/cli.test.ts"
  }
}
```

- [ ] **Step 5: Thread a real model client from runtime config**

```ts
export interface StoryModelClient {
  rerankActorActions(actions: StoryAction[], context: ActorDecisionInput): Promise<StoryAction[]>;
  rerankFactionActions(actions: StoryAction[], context: FactionDecisionInput): Promise<StoryAction[]>;
  rerankChapterFocus(candidates: ChapterSelection[], context: NarrativeDirectorInput): Promise<ChapterSelection[]>;
  generateChapter(packet: ChapterPacket): Promise<string>;
  summarizeTurn(input: TurnSummaryInput): Promise<string>;
  extractClaims(prose: string): Promise<StoryClaim[]>;
}

export function createStoryModelClient(cfg: StoryRuntimeConfig["llm"]): StoryModelClient {
  if (cfg.mode === "anthropic-compatible") {
    return createAnthropicCompatibleClient(cfg);
  }
  return createOpenAICompatibleClient(cfg);
}
```

- [ ] **Step 6: Run the targeted tests**

Run: `npx vitest run test/story/bootstrap.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add package.json src/engine/llm.ts src/story/config.ts src/story/cli.ts src/story/runtime/model-client.ts test/story/bootstrap.test.ts
git commit -m "feat: scaffold story runtime config"
```

## Task 2: Define Narrative Ontology and Seed Bootstrap

**Files:**
- Create: `src/story/types.ts`
- Create: `src/story/bootstrap.ts`
- Create: `src/story/world-state.ts`
- Modify: `src/types.ts`
- Test: `test/story/bootstrap.test.ts`

- [ ] **Step 1: Write failing ontology and bootstrap tests**

```ts
import { createSeedWorld } from "../../src/story/bootstrap.ts";

it("builds a seed world with characters, factions, and threads", () => {
  const world = createSeedWorld();
  expect(world.characters.length).toBeGreaterThanOrEqual(3);
  expect(world.factions.length).toBeGreaterThanOrEqual(2);
  expect(world.threads.length).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/story/bootstrap.test.ts`
Expected: FAIL because `createSeedWorld` is missing.

- [ ] **Step 3: Implement the narrative types and mixed bootstrap path**

```ts
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
```

- [ ] **Step 4: Add a hand-authored seed world**

```ts
export function createSeedWorld(): SeedWorld {
  return {
    characters: [
      { id: "c-li-yao", name: "Li Yao", realm: "Foundation", coreDesires: ["survive", "ascend"], shortTermGoals: ["hide-bloodline"], taboos: ["betray-master"], resources: { spiritStones: 40, reputation: 10 }, hiddenTruths: ["ancient-bloodline"], emotionalVectors: { "c-su-wan": 0.6, "c-shen-mo": -0.4 }, publicIdentity: "outer-sect disciple", privateIdentity: "sealed heir" },
      { id: "c-shen-mo", name: "Shen Mo", realm: "Core", coreDesires: ["control-sect"], shortTermGoals: ["purge-rivals"], taboos: ["lose-face"], resources: { spiritStones: 900, reputation: 80 }, hiddenTruths: ["stole-inheritance-clue"], emotionalVectors: { "c-li-yao": -0.6 }, publicIdentity: "orthodox elder", privateIdentity: "inheritance usurper" },
      { id: "c-su-wan", name: "Su Wan", realm: "Foundation", coreDesires: ["protect-clan"], shortTermGoals: ["recover-artifact"], taboos: ["abandon-family"], resources: { spiritStones: 120, reputation: 35 }, hiddenTruths: ["knows-ember-seal-history"], emotionalVectors: { "c-li-yao": 0.7 }, publicIdentity: "quiet disciple", privateIdentity: "last clan witness" }
    ],
    factions: [
      { id: "f-cloud-sword", name: "Cloud Sword Sect", agenda: ["preserve-orthodoxy", "control-secret-realm"], constraints: ["inheritance-dispute"], doctrine: "order-before-truth", internalBlocks: ["elder-lineage-rivalry"], strategicTargets: ["a-ember-seal"], publicPosture: "righteous-sect", hiddenOperations: ["surveil-disciples"] },
      { id: "f-black-river", name: "Black River Hall", agenda: ["steal-artifacts", "destabilize-rivals"], constraints: ["resource-shortage"], doctrine: "profit-through-chaos", internalBlocks: ["masked-envoy-faction"], strategicTargets: ["l-fallen-realm"], publicPosture: "neutral-traders", hiddenOperations: ["seed-rumors"] }
    ],
    locations: [
      { id: "l-cloud-peak", name: "Cloud Peak", kind: "sect" },
      { id: "l-fallen-realm", name: "Fallen Ember Secret Realm", kind: "secret-realm" }
    ],
    artifacts: [
      { id: "a-ember-seal", name: "Ember Seal", kind: "inheritance-token", ownerId: "c-shen-mo" }
    ],
    threads: [
      { id: "t-secret-realm", name: "Secret realm inheritance struggle", status: "active" }
    ],
    rules: [
      { id: "r-secrecy", name: "bloodline secrecy taboo", effect: "exposure-triggers-pursuit" }
    ],
    tone: {
      genre: "xianxia",
      mood: "tense and fate-driven",
      proseStyle: "elevated but readable"
    }
  };
}
```

- [ ] **Step 5: Add explicit world initialization contract**

```ts
export function initializeStoryWorld(db: DatabaseSyncInstance) {
  const world = createStoryWorldState(db);
  if (world.listCharacters().length === 0) {
    world.saveSeed(createSeedWorld());
  }
  return world;
}
```

- [ ] **Step 6: Run the targeted tests**

Run: `npx vitest run test/story/bootstrap.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/story/types.ts src/story/bootstrap.ts src/story/world-state.ts src/types.ts test/story/bootstrap.test.ts
git commit -m "feat: define story ontology and seed world"
```

## Task 3: Add World-State Persistence for Story Entities

**Files:**
- Modify: `src/store/db.ts`
- Modify: `src/store/store.ts`
- Create: `src/story/world-state.ts`
- Modify: `test/helpers.ts`
- Test: `test/story/world-state.test.ts`

- [ ] **Step 1: Write failing persistence tests**

```ts
it("persists story entities and relationships", () => {
  const db = createTestDb();
  const world = createStoryWorldState(db);
  world.saveSeed(createSeedWorld());

  expect(world.listCharacters()).toHaveLength(3);
  expect(world.listThreads()[0].status).toBe("active");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/story/world-state.test.ts`
Expected: FAIL because story tables and `createStoryWorldState` are missing.

- [ ] **Step 3: Add story tables and CRUD support**

```sql
CREATE TABLE IF NOT EXISTS story_entities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS story_relations (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  to_id TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'public',
  intensity REAL NOT NULL DEFAULT 1,
  source_event_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS story_events (
  id TEXT PRIMARY KEY,
  turn_number INTEGER NOT NULL,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS story_turns (
  turn_number INTEGER PRIMARY KEY,
  summary TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS story_beliefs (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object_id TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS story_chapters (
  id TEXT PRIMARY KEY,
  turn_number INTEGER NOT NULL,
  pov_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  prose TEXT NOT NULL,
  claims_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS story_narrative_signals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  related_id TEXT,
  weight REAL NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS story_director_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

- [ ] **Step 4: Implement world-state repository methods**

```ts
export function createStoryWorldState(db: DatabaseSyncInstance) {
  return {
    saveSeed(seed: SeedWorld) {
      insertStoryEntities(db, seed.characters, "character");
      insertStoryEntities(db, seed.factions, "faction");
      insertStoryEntities(db, seed.locations, "location");
      insertStoryEntities(db, seed.artifacts, "artifact");
      insertStoryEntities(db, seed.threads, "thread");
      insertStoryRelation(db, { fromId: "c-li-yao", relation: "KNOWS", toId: "c-su-wan", visibility: "public" });
      insertStoryRelation(db, { fromId: "c-li-yao", relation: "FEELS", toId: "c-su-wan", visibility: "private", intensity: 0.6 });
      insertStoryRelation(db, { fromId: "a-ember-seal", relation: "OWNS", toId: "c-shen-mo", visibility: "public" });
      upsertStoryNarrativeSignal(db, { id: "ns-secret-bloodline", kind: "secret", subjectId: "c-li-yao", relatedId: "t-secret-realm", weight: 0.8, payloadJson: JSON.stringify({ secret: "ancient-bloodline" }), status: "active" });
      upsertStoryNarrativeSignal(db, { id: "ns-realm-tension", kind: "tension", subjectId: "f-cloud-sword", relatedId: "t-secret-realm", weight: 0.7, payloadJson: JSON.stringify({ cause: "inheritance-dispute" }), status: "active" });
    },
    listCharacters() {
      return listStoryEntitiesByKind(db, "character");
    },
    listThreads() {
      return listStoryEntitiesByKind(db, "thread");
    },
    recordTurn(summary: StoryTurnRecord) {
      return insertStoryTurn(db, summary);
    },
    recordEvents(events: StoryResolvedEvent[]) {
      events.forEach((event) => insertStoryEvent(db, event));
    },
    upsertNarrativeSignal(signal: StoryNarrativeSignal) {
      return upsertStoryNarrativeSignal(db, signal);
    },
    upsertNarrativeSignals(signals: StoryNarrativeSignal[]) {
      signals.forEach((signal) => upsertStoryNarrativeSignal(db, signal));
    }
  };
}
```

- [ ] **Step 5: Run the targeted tests**

Run: `npx vitest run test/story/world-state.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/store/db.ts src/store/store.ts src/story/world-state.ts test/helpers.ts test/story/world-state.test.ts
git commit -m "feat: add story world-state persistence"
```

## Task 4: Implement Subjective Beliefs and Recall Queries

**Files:**
- Create: `src/story/beliefs.ts`
- Create: `src/story/memory/recall.ts`
- Modify: `src/store/store.ts`
- Test: `test/story/beliefs.test.ts`
- Test: `test/story/memory-recall.test.ts`

- [ ] **Step 1: Write failing belief and recall tests**

```ts
it("stores canonical truth separately from character belief", () => {
  const belief = repo.upsertBelief({
    actorId: "c-li-yao",
    actorKind: "character",
    subjectId: "a-ember-seal",
    predicate: "OWNS",
    objectId: "c-su-wan",
    confidence: 0.7
  });
  const truth = repo.recordRelation("artifact-1", "OWNS", "c-shen-mo");

  expect(belief.objectId).toBe("c-su-wan");
  expect(truth.toId).toBe("c-shen-mo");
});

it("recalls thread and relationship context for a pov actor", () => {
  const packet = buildRecallPacket(db, { povId: "c-li-yao", eventIds: ["e-secret-realm"] });
  expect(packet.relationships.length).toBeGreaterThan(0);
  expect(packet.threads.length).toBeGreaterThan(0);
});

it("propagates public events into beliefs but keeps hidden events private", () => {
  propagateBeliefsFromEvents(db, [
    { id: "e-public", visibility: "public", observers: ["c-li-yao"], payload: { subjectId: "a-ember-seal", predicate: "OWNS", objectId: "c-shen-mo" } },
    { id: "e-hidden", visibility: "private", observers: ["c-shen-mo"], payload: { subjectId: "c-li-yao", predicate: "BLOODLINE", objectId: "ancient" } }
  ]);
  expect(listBeliefsForActor(db, "c-li-yao")).toHaveLength(1);
  expect(listBeliefsForActor(db, "c-su-wan")).toHaveLength(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/story/beliefs.test.ts test/story/memory-recall.test.ts`
Expected: FAIL because belief storage and recall packet builders do not exist.

- [ ] **Step 3: Implement belief-state repository helpers**

```ts
export interface StoryBelief {
  actorId: string;
  subjectId: string;
  predicate: string;
  objectId: string;
  confidence: number;
  actorKind: "character" | "faction";
}
```

- [ ] **Step 4: Implement belief propagation from resolved events**

```ts
export function propagateBeliefsFromEvents(db: DatabaseSyncInstance, events: StoryResolvedEvent[]) {
  for (const event of events) {
    const observers = event.visibility === "public"
      ? [...listObservableActors(db), ...listObservableFactions(db)]
      : event.observers;
    observers.forEach((actorId) => {
      upsertBeliefFromEvent(db, actorId, event);
    });
  }
}
```

- [ ] **Step 5: Implement recall packet assembly**

```ts
export function buildRecallPacket(db: DatabaseSyncInstance, params: {
  povId: string;
  eventIds: string[];
}) {
  return {
    relatedEvents: listEventsForPov(db, params.povId, params.eventIds),
    relationships: listRelationshipsForPov(db, params.povId),
    threads: listActiveThreadsForEvents(db, params.eventIds),
    unresolvedSecrets: listNarrativeSignals(db, "secret", params.povId),
    activeTensions: listNarrativeSignals(db, "tension", params.povId),
    payoffCandidates: listNarrativeSignals(db, "payoff-candidate", params.povId)
  };
}
```

- [ ] **Step 6: Run the targeted tests**

Run: `npx vitest run test/story/beliefs.test.ts test/story/memory-recall.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/story/beliefs.ts src/story/memory/recall.ts src/store/store.ts test/story/beliefs.test.ts test/story/memory-recall.test.ts
git commit -m "feat: add subjective beliefs and story recall"
```

## Task 5: Build Actor and Faction Decision Engines

**Files:**
- Create: `src/story/decision/actor-engine.ts`
- Create: `src/story/decision/faction-engine.ts`
- Test: `test/story/decision.test.ts`

- [ ] **Step 1: Write failing decision-engine tests**

```ts
it("ranks actor actions using desires, goals, and beliefs", async () => {
  const actions = await rankActorActions({
    actor: liYao,
    beliefs: [artifactBelief],
    worldSignals: [secretRealmOpening],
    model: fakeDecisionModel()
  });

  expect(actions[0].type).toBe("seek-artifact");
});

it("ranks faction actions using agenda, beliefs, and constraints", async () => {
  const actions = await rankFactionActions({
    faction: sect,
    beliefs: [factionBelief],
    worldSignals: [rivalInheritanceRumor],
    model: fakeDecisionModel()
  });

  expect(actions[0].type).toBe("purge-rival-line");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/story/decision.test.ts`
Expected: FAIL because ranking functions are missing.

- [ ] **Step 3: Implement deterministic candidate ranking**

Use heuristics for first-pass scoring, then structured model assistance for reranking ties or near-ties:

```ts
export async function rankActorActions(input: ActorDecisionInput): Promise<StoryAction[]> {
  const scored = buildCandidateActions(input)
    .map(scoreAction)
    .sort((a, b) => b.score - a.score);
  const reranked = await input.model.rerankActorActions(scored, input);
  return reranked.slice(0, 2);
}
```

- [ ] **Step 4: Mirror the same hybrid structure for factions**

```ts
export async function rankFactionActions(input: FactionDecisionInput): Promise<StoryAction[]> {
  const scored = buildFactionCandidates(input)
    .map(scoreFactionAction)
    .sort((a, b) => b.score - a.score);
  const reranked = await input.model.rerankFactionActions(scored, input);
  return reranked.slice(0, 2);
}
```

- [ ] **Step 5: Run the targeted tests**

Run: `npx vitest run test/story/decision.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/story/decision/actor-engine.ts src/story/decision/faction-engine.ts test/story/decision.test.ts
git commit -m "feat: add actor and faction decision engines"
```

## Task 6: Build Turn Simulation and Event Resolution

**Files:**
- Create: `src/story/events.ts`
- Create: `src/story/turn-simulator.ts`
- Test: `test/story/turn-simulator.test.ts`

- [ ] **Step 1: Write failing turn simulation tests**

```ts
it("advances one turn and records resolved events", async () => {
  const result = await runStoryTurn(db, seedContext);
  expect(result.turnNumber).toBe(1);
  expect(result.events.length).toBeGreaterThan(0);
  expect(result.stateChanges.length).toBeGreaterThan(0);
});

it("creates conflicts when competing actions target the same artifact", async () => {
  const result = await runStoryTurn(db, conflictFixture);
  expect(result.events.some((event) => event.type === "artifact-conflict")).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/story/turn-simulator.test.ts`
Expected: FAIL because turn simulator and event resolution are missing.

- [ ] **Step 3: Implement the six-stage turn loop**

```ts
export async function runStoryTurn(db: DatabaseSyncInstance, input: StoryTurnInput) {
  const settlement = settleWorldState(db, input);
  const actorActions = (await Promise.all(settlement.actors.map((actor) =>
    rankActorActions({ actor, beliefs: settlement.beliefsByActor[actor.id] ?? [], worldSignals: settlement.worldSignals, model: input.model })
  ))).flat();
  const factionActions = (await Promise.all(settlement.factions.map((faction) =>
    rankFactionActions({ faction, beliefs: settlement.beliefsByFaction[faction.id] ?? [], worldSignals: settlement.worldSignals, model: input.model })
  ))).flat();
  const events = resolveActionConflicts([...actorActions, ...factionActions]);
  const updates = applyResolvedEvents(db, events);
  const narrativeSignals = deriveNarrativeSignalsFromEvents(events);
  const world = createStoryWorldState(db);
  world.recordEvents(events);
  world.upsertNarrativeSignals(narrativeSignals);
  propagateBeliefsFromEvents(db, events);
  return { turnNumber: input.turnNumber, events, stateChanges: updates };
}
```

- [ ] **Step 4: Persist turn and event records**

Run code path should call:

```ts
world.recordTurn({
  turnNumber: input.turnNumber,
  summary: summarizeResolvedEvents(events),
  events
});
world.recordEvents(events);
world.upsertNarrativeSignals(deriveNarrativeSignalsFromEvents(events));
propagateBeliefsFromEvents(db, events);
```

- [ ] **Step 5: Run the targeted tests**

Run: `npx vitest run test/story/turn-simulator.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/story/events.ts src/story/turn-simulator.ts test/story/turn-simulator.test.ts
git commit -m "feat: add story turn simulator"
```

## Task 7: Add Narrative Director and Chapter Generator

**Files:**
- Create: `src/story/narrative/director.ts`
- Create: `src/story/narrative/chapter-generator.ts`
- Create: `src/story/narrative/state.ts`
- Modify: `src/story/world-state.ts`
- Test: `test/story/director.test.ts`
- Test: `test/story/chapter-generator.test.ts`

- [ ] **Step 1: Write failing narrative tests**

```ts
it("selects a single primary pov and chapter-worthy event bundle", async () => {
  const choice = await selectChapterFocus({
    events: fixtureEvents,
    activeTensions: fixtureTensions,
    activeThreads: fixtureThreads,
    ensembleState: fixtureEnsemble,
    recentPovIds: ["c-li-yao", "c-li-yao"],
    model: fakeDirectorModel()
  });

  expect(choice.primaryPovId).toBeDefined();
  expect(choice.eventIds.length).toBeGreaterThan(0);
});

it("generates prose from a bounded chapter packet", async () => {
  const output = await generateChapter(fakeModel, chapterPacket);
  expect(output.prose.length).toBeGreaterThan(100);
  expect(output.claims.length).toBeGreaterThan(0);
});

it("assembles a bounded chapter packet from recall and director state", () => {
  const packet = buildChapterPacket(db, turnResult, directorState, chapterSelection);
  expect(packet.relationshipHistory.length).toBeGreaterThan(0);
  expect(packet.unresolvedSecrets.length).toBeGreaterThan(0);
  expect(packet.activeTensionSummary.length).toBeGreaterThan(0);
  expect(packet.chapterEndHook).toBeTruthy();
});

it("avoids repeating the same pov when recent pov history is saturated", async () => {
  const choice = await selectChapterFocus({
    events: fixtureEvents,
    activeThreads: fixtureThreads,
    activeTensions: fixtureTensions,
    ensembleState: fixtureEnsemble,
    recentPovIds: ["c-li-yao", "c-li-yao", "c-li-yao"],
    model: fakeDirectorModel()
  });
  expect(choice.primaryPovId).not.toBe("c-li-yao");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/story/director.test.ts test/story/chapter-generator.test.ts`
Expected: FAIL because the director and generator do not exist.

- [ ] **Step 3: Implement deterministic chapter focus selection**

Use heuristic bundle scoring plus model-assisted reranking, and explicitly penalize overused POVs:

```ts
export async function selectChapterFocus(input: NarrativeDirectorInput): Promise<ChapterSelection> {
  const ranked = scoreEventBundles(input)
    .map((bundle) => applyPovRecencyPenalty(bundle, input.recentPovIds))
    .sort((a, b) => b.score - a.score);
  const reranked = await input.model.rerankChapterFocus(ranked, input);
  return reranked[0];
}
```

- [ ] **Step 4: Persist and update director meta-state**

```ts
export function loadDirectorState(db: DatabaseSyncInstance): NarrativeDirectorState {
  return {
    activeThreads: listTrackedThreads(db),
    unresolvedSecrets: listNarrativeSignals(db, "secret"),
    activeTensions: listNarrativeSignals(db, "tension"),
    payoffCandidates: listNarrativeSignals(db, "payoff-candidate"),
    ensembleHeat: listEnsembleHeat(db),
    recentPovIds: listRecentPovs(db)
  };
}

export function saveDirectorState(db: DatabaseSyncInstance, state: NarrativeDirectorState): void {
  upsertDirectorState(db, state);
}
```

- [ ] **Step 5: Implement explicit director-state evolution**

```ts
export function updateDirectorStateFromTurn(
  db: DatabaseSyncInstance,
  state: NarrativeDirectorState,
  turnResult: StoryTurnResult,
  selection: ChapterSelection
): NarrativeDirectorState {
  return {
    activeThreads: reconcileActiveThreads(state.activeThreads, turnResult.events),
    unresolvedSecrets: reconcileSignals(state.unresolvedSecrets, turnResult.events, "secret"),
    activeTensions: reconcileSignals(state.activeTensions, turnResult.events, "tension"),
    payoffCandidates: reconcileSignals(state.payoffCandidates, turnResult.events, "payoff-candidate"),
    ensembleHeat: updateEnsembleHeat(state.ensembleHeat, turnResult.events),
    recentPovIds: appendRecentPov(state.recentPovIds, selection.primaryPovId)
  };
}
```

- [ ] **Step 6: Implement structured chapter generation**

```ts
export async function generateChapter(model: StoryModelClient, packet: ChapterPacket) {
  const prose = await model.generateChapter(packet);
  return {
    prose,
    summary: summarizeChapter(packet),
    claims: await extractChapterClaims(model, prose)
  };
}
```

- [ ] **Step 7: Assemble a bounded chapter packet before prose generation**

```ts
export function buildChapterPacket(
  db: DatabaseSyncInstance,
  turnResult: StoryTurnResult,
  directorState: NarrativeDirectorState,
  selection: ChapterSelection
): ChapterPacket {
  const recall = buildRecallPacket(db, { povId: selection.primaryPovId, eventIds: selection.eventIds });

  return {
    turnNumber: turnResult.turnNumber,
    primaryPovId: selection.primaryPovId,
    secondaryPovId: selection.secondaryPovId,
    selectedEvents: turnResult.events.filter((event) => selection.eventIds.includes(event.id)),
    eventSummaries: turnResult.events
      .filter((event) => selection.eventIds.includes(event.id))
      .map((event) => event.summary),
    stateDeltas: turnResult.stateChanges.filter((delta) => selection.eventIds.includes(delta.sourceEventId)),
    relationshipHistory: recall.relationships,
    unresolvedSecrets: recall.unresolvedSecrets,
    activeTensionSummary: summarizeSignals(recall.activeTensions),
    toneTarget: selection.toneTarget,
    pacingTarget: selection.pacingTarget,
    chapterEndHook: selection.hookTarget
  };
}
```

- [ ] **Step 8: Persist generated chapters before validation**

```ts
export async function createAndStoreChapter(db: DatabaseSyncInstance, model: StoryModelClient, packet: ChapterPacket) {
  const chapter = await generateChapter(model, packet);
  insertStoryChapter(db, {
    turnNumber: packet.turnNumber,
    povId: packet.primaryPovId,
    summary: chapter.summary,
    prose: chapter.prose,
    claimsJson: JSON.stringify(chapter.claims)
  });
  return chapter;
}
```

- [ ] **Step 9: Run the targeted tests**

Run: `npx vitest run test/story/director.test.ts test/story/chapter-generator.test.ts`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/story/narrative/director.ts src/story/narrative/chapter-generator.ts src/story/narrative/state.ts src/story/world-state.ts test/story/director.test.ts test/story/chapter-generator.test.ts
git commit -m "feat: add narrative director and chapter generator"
```

## Task 8: Add Consistency Validation and Chapter Cadence

**Files:**
- Create: `src/story/memory/consistency.ts`
- Create: `src/story/runtime/run-loop.ts`
- Create: `test/story/long-run.test.ts`
- Test: `test/story/consistency.test.ts`
- Test: `test/story/run-loop.test.ts`

- [ ] **Step 1: Write failing consistency and cadence tests**

```ts
it("flags chapter claims that contradict current world state", () => {
  const issues = validateChapterClaims(worldSnapshot, [
    { subjectId: "artifact-1", predicate: "OWNS", objectId: "c-li-yao" }
  ]);

  expect(issues).toHaveLength(1);
});

it("emits chapter prose every three turns by default", async () => {
  const result = await runStoryLoop(db, { turns: 3, model: fakeStoryModel() });
  expect(result.chapters).toHaveLength(1);
  expect(result.worldLogs).toHaveLength(3);
});

it("keeps active threads coherent across twenty turns", async () => {
  const result = await runStoryLoop(db, { turns: 20, model: fakeStoryModel() });
  expect(result.worldLogs).toHaveLength(20);
  expect(result.finalDirectorState.activeThreads.length).toBeGreaterThan(0);
  expect(result.consistencyIssues).toHaveLength(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/story/consistency.test.ts test/story/run-loop.test.ts`
Expected: FAIL because validation and run-loop cadence are missing.

- [ ] **Step 3: Implement factual claim validation**

```ts
export function validateChapterClaims(world: StoryWorldSnapshot, claims: StoryClaim[]) {
  return claims.filter((claim) => contradictsWorld(world, claim));
}
```

Define the claim contract explicitly before implementation:

```ts
export interface StoryClaim {
  subjectId: string;
  predicate: "OWNS" | "LOCATED_IN" | "ALLY_OF" | "ENEMY_OF" | "INJURED" | "DEAD";
  objectId?: string;
  valueText?: string;
  evidenceSpan: string;
}

export async function extractChapterClaims(model: StoryModelClient, prose: string): Promise<StoryClaim[]> {
  return model.extractClaims(prose);
}

export function buildStoryWorldSnapshot(db: DatabaseSyncInstance): StoryWorldSnapshot {
  return {
    entities: listAllStoryEntities(db),
    relations: listAllStoryRelations(db),
    activeThreads: listTrackedThreads(db),
    narrativeSignals: listAllNarrativeSignals(db)
  };
}

export function validateRecentChapters(db: DatabaseSyncInstance) {
  const world = buildStoryWorldSnapshot(db);
  const chapters = listRecentStoryChapters(db, 5);
  return chapters.flatMap((chapter) =>
    validateChapterClaims(world, JSON.parse(chapter.claimsJson))
  );
}
```

- [ ] **Step 4: Implement the run loop with configurable chapter cadence**

```ts
export async function runStoryLoop(db: DatabaseSyncInstance, input: { turns: number; model?: StoryModelClient }) {
  initializeStoryWorld(db);
  const cfg = loadStoryConfig();
  const model = input.model ?? createStoryModelClient(cfg.llm);
  const chapters = [];
  const worldLogs = [];
  let directorState = loadDirectorState(db);
  let nextTurnNumber = getNextStoryTurnNumber(db, cfg.resetOnStart);

  for (let i = 0; i < input.turns; i++) {
    const turnResult = await runStoryTurn(db, { turnNumber: nextTurnNumber, model });
    worldLogs.push(turnResult);
    const chapterCandidate = await selectChapterFocus({
      events: turnResult.events,
      activeThreads: directorState.activeThreads,
      activeTensions: directorState.activeTensions,
      ensembleState: directorState.ensembleHeat,
      recentPovIds: directorState.recentPovIds,
      model
    });
    directorState = updateDirectorStateFromTurn(db, directorState, turnResult, chapterCandidate);
    saveDirectorState(db, directorState);
    if (nextTurnNumber % cfg.chapterEveryTurns === 0) {
      const packet = buildChapterPacket(db, turnResult, directorState, chapterCandidate);
      chapters.push(await createAndStoreChapter(db, model, packet));
    }
    nextTurnNumber += 1;
  }

  return {
    worldLogs,
    chapters,
    finalDirectorState: directorState,
    consistencyIssues: validateRecentChapters(db)
  };
}
```

Reset semantics must be explicit:

```ts
export function getNextStoryTurnNumber(db: DatabaseSyncInstance, resetOnStart: boolean): number {
  if (resetOnStart) {
    clearStoryRuntimeState(db);
    initializeStoryWorld(db);
    return 1;
  }
  return readMaxStoryTurnNumber(db) + 1;
}

export function clearStoryRuntimeState(db: DatabaseSyncInstance): void {
  deleteFrom(db, "story_turns");
  deleteFrom(db, "story_events");
  deleteFrom(db, "story_beliefs");
  deleteFrom(db, "story_chapters");
  deleteFrom(db, "story_director_state");
  deleteFrom(db, "story_narrative_signals");
}
```

- [ ] **Step 5: Run the targeted tests**

Run: `npx vitest run test/story/consistency.test.ts test/story/run-loop.test.ts test/story/long-run.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/story/memory/consistency.ts src/story/runtime/run-loop.ts test/story/consistency.test.ts test/story/run-loop.test.ts test/story/long-run.test.ts
git commit -m "feat: add story loop cadence and consistency checks"
```

## Task 9: Wire CLI, Documentation, and Full Story Test Suite

**Files:**
- Modify: `src/story/cli.ts`
- Modify: `README.md`
- Test: `test/story/cli.test.ts`
- Test: `test/story/run-loop.test.ts`
- Test: `test/story/bootstrap.test.ts`
- Test: `test/story/world-state.test.ts`
- Test: `test/story/beliefs.test.ts`
- Test: `test/story/decision.test.ts`
- Test: `test/story/turn-simulator.test.ts`
- Test: `test/story/memory-recall.test.ts`
- Test: `test/story/consistency.test.ts`
- Test: `test/story/director.test.ts`
- Test: `test/story/chapter-generator.test.ts`

- [ ] **Step 1: Write a failing CLI integration test**

```ts
it("runs a short story simulation and prints output paths", async () => {
  const result = await execa("npm", ["run", "story:run", "--", "--turns=3", "--stub-model"]);
  expect(result.stdout).toContain("turns=3");
  expect(result.stdout).toContain("chapters=1");
});
```

- [ ] **Step 2: Run the CLI test to verify it fails**

Run: `npx vitest run test/story/cli.test.ts`
Expected: FAIL because the CLI does not yet orchestrate the full loop.

- [ ] **Step 3: Implement CLI orchestration and docs**

```ts
const cfg = loadStoryConfig();
const model = argv.includes("--stub-model") ? createStubStoryModelClient() : createStoryModelClient(cfg.llm);
initializeStoryWorld(db);
const result = await runStoryLoop(db, { turns, model });
console.log(`turns=${result.worldLogs.length}`);
console.log(`chapters=${result.chapters.length}`);
console.log(`db=${process.env.NOVEL_DB_PATH ?? "~/.graph-memory/story-memory.db"}`);
console.log(`resetOnStart=${cfg.resetOnStart}`);
```

Add a `README.md` section that documents:

- required environment variables
- how to run the simulator
- how chapter cadence works
- how secrets must be provided through env vars only
- that story runtime defaults to `NOVEL_DB_PATH` instead of the OpenClaw plugin DB

Implement the stub model in this task so tests never depend on live credentials:

```ts
export function createStubStoryModelClient(): StoryModelClient {
  return {
    rerankActorActions: async (actions) => actions,
    rerankFactionActions: async (actions) => actions,
    rerankChapterFocus: async (candidates) => candidates,
    generateChapter: async (packet) => `Chapter for ${packet.primaryPovId}`,
    summarizeTurn: async () => "stub turn summary",
    extractClaims: async () => []
  };
}
```

- [ ] **Step 4: Run the story suite**

Run: `npm run test:story`
Expected: PASS with all listed `test/story/` files green

- [ ] **Step 5: Run the CLI suite explicitly**

Run: `npm run test:story:cli`
Expected: PASS with `test/story/cli.test.ts` green

- [ ] **Step 6: Run the full repository suite**

Run: `npm test`
Expected: PASS with existing plugin tests plus new story tests

- [ ] **Step 7: Commit**

```bash
git add README.md src/story/cli.ts test/story/cli.test.ts
git commit -m "feat: wire xianxia story simulation mvp"
```

## Verification Checklist

Before calling the MVP complete, verify all of the following:

- `npm run test:story` passes
- `npm run test:story:cli` passes
- `npm test` passes
- `npm run story:run -- --turns=3` emits 3 world logs and 1 chapter
- `npm run story:run -- --turns=6` emits 6 world logs and 2 chapters
- `npm run story:run -- --turns=20` preserves active threads and reports no consistency failures
- no committed file contains `NOVEL_LLM_API_KEY` values or hard-coded production secrets
- the README story runtime section is enough for a new engineer to run the MVP locally

## Execution Notes

- Keep the existing OpenClaw plugin path intact while building the story runtime in parallel.
- Do not rewrite `index.ts` during the MVP unless a small compatibility shim is needed.
- Prefer adding new `src/story/` modules over mutating the OpenClaw-specific flow.
- Reuse existing store and graph utilities only where their semantics match narrative needs.
- If a task exposes the need for a second independent product surface, stop and split the plan instead of letting scope expand invisibly.
