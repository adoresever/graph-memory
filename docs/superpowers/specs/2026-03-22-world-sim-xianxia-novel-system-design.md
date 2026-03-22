# World-Sim Xianxia Novel System Design

Date: 2026-03-22
Status: Approved for planning
Project: graph-memory

## Summary

This design repurposes `graph-memory` from an OpenClaw conversation memory plugin into the foundation of a fully automatic xianxia novel generation system. The target system is not a prompt-driven chapter writer. It is a layered world simulation engine that:

- maintains a persistent knowledge graph of characters, factions, locations, artifacts, rules, events, and long-running narrative threads
- simulates world evolution in discrete turns
- lets characters and factions act from their own goals, resources, and incomplete knowledge
- selects the most narratively meaningful developments from the simulation
- produces both an internal world log and reader-facing novel chapters

The intended storytelling mode is:

- fully automatic
- open-ended emergent evolution
- mixed character-driven and faction-driven progression
- turn-based world updates
- ensemble cast
- dual outputs: world-state logs and polished chapter prose
- xianxia / cultivation setting

## Product Goal

Build a system that can continuously generate a living cultivation world where:

- characters pursue their own agendas
- factions compete over power, doctrine, inheritance, territory, and resources
- relationships, betrayals, secrets, and causal chains persist over time
- plotlines emerge from world state rather than from a single prewritten outline
- readable novel chapters can be extracted from the evolving simulation without breaking continuity

## Non-Goals

The first version does not aim to:

- generate a million-word production-ready novel in one pass
- simulate every minor NPC as a fully independent agent
- implement a deep numeric combat engine or economy simulator
- optimize for OpenClaw plugin compatibility
- preserve the current `TASK / SKILL / EVENT` ontology as the core model

## Design Principles

1. World truth and narrative meaning are not the same thing.
2. Characters act on what they believe, not on omniscient reality.
3. The simulation must be able to surprise the writing layer.
4. The writing layer must still produce readable, focused chapters.
5. Long-term consistency matters more than short-term flourish.

## System Shape

The system is split into four conceptual layers:

1. World fact layer
2. Decision and simulation layer
3. Memory and consistency layer
4. Narrative director and chapter generation layer

`graph-memory` already provides useful building blocks for storage, graph traversal, full-text search, vector recall, ranking, and graph maintenance. Those should be retained where possible. The domain ontology, extraction prompts, recall heuristics, and assembly format should be rewritten for narrative simulation instead of agent tooling memory.

The recommended implementation style is hybrid:

- `ActorDecisionEngine` should combine explicit heuristics and structured model calls
- `NarrativeDirector` should combine scoring heuristics with model-assisted selection and packaging
- `ChapterGenerator` should remain primarily model-driven, but with tightly structured inputs and post-generation factual checks

## Core Graph Model

### Two graphs, not one

The system should maintain two related but distinct views of state.

#### 1. World fact graph

Represents what objectively exists or has occurred in the world.

Recommended node families:

- `Character`
- `Faction`
- `Location`
- `Artifact`
- `Technique`
- `Rule`
- `Event`
- `Thread`

Recommended edge families:

- `KIN_OF`
- `MASTER_OF`
- `ALLY_OF`
- `ENEMY_OF`
- `LOVES`
- `FEARS`
- `OWES`
- `BETRAYED`
- `OWNS`
- `SEEKS`
- `GUARDS`
- `STOLE`
- `LOCATED_IN`
- `BELONGS_TO`
- `CONTROLS`
- `PARTICIPATES_IN`
- `AFFECTS`
- `CAUSED`
- `TRIGGERED`
- `REVEALED`
- `COVERS_UP`
- `CONFLICTS_WITH`
- `DEPENDS_ON`

This graph answers questions like:

- who is related to whom
- who controls what
- what happened
- what caused what
- what unresolved constraints now exist

#### 2. Narrative significance graph

Represents why something matters narratively.

Recommended node families:

- `Hook`
- `Secret`
- `Tension`
- `Foreshadow`
- `PayoffCandidate`
- `POVCandidate`
- `ArcShift`

Recommended edge families:

- `FORESHADOWS`
- `PAYS_OFF`
- `ESCALATES`
- `THREATENS`
- `HIDES`
- `EXPOSES`
- `CENTERS_ON`
- `PARALLELS`

This graph answers questions like:

- which event is becoming a turning point
- which relationships are close to rupture
- which unresolved threads deserve chapter focus
- which characters are currently the best POV candidates

### Temporal and mutable state

The graph must support change over time. The system should treat many relationships as dynamic rather than static.

Examples:

- trust between characters rises or collapses
- a faction’s public stance differs from its hidden agenda
- an artifact changes owner
- a thread shifts from dormant to active to resolved

Important properties to attach to nodes and edges include:

- timestamp or turn range
- intensity or confidence
- public vs hidden visibility
- source event
- status such as active, dormant, broken, resolved, concealed

## Subjective Knowledge Model

The system should not let every actor read the same reality.

There should be:

- one canonical world truth state
- one subjective belief state per major character
- optional belief state per major faction

Characters make decisions from subjective belief state. Resolution happens against canonical world state.

This enables:

- misunderstandings
- false accusations
- failed schemes
- accidental betrayals
- dramatic irony
- strategic deception

This is critical for xianxia ensemble storytelling because information asymmetry is a major source of conflict.

## Turn Loop

Each simulation turn should follow a fixed six-stage pipeline.

### 1. World settlement

Advance time and resolve ongoing background processes.

Examples:

- healing
- closed-door cultivation progress
- travel progress
- secret investigations
- faction plans reaching a deadline
- resource depletion
- realm breakthrough pressure
- secret realm opening timers

Output:

- updated world state
- no chapter text yet

### 2. Intent generation

Each major character and faction generates candidate actions based on:

- core desires
- current goals
- relationships
- resources
- fears and taboos
- beliefs and misinformation
- current opportunities and threats

Actions should distinguish between:

- public moves
- covert moves
- reactive moves
- long-horizon setup moves

### 3. Conflict resolution

Candidate actions are evaluated together to determine which collide, succeed, partially succeed, or fail.

Typical conflicts:

- multiple actors pursuing the same artifact
- a rescue colliding with a purge order
- concealment colliding with surveillance
- faction discipline colliding with personal loyalty

Output:

- resolved events
- world-state deltas
- reputational consequences
- new secrets and exposures

### 4. Graph update

The resulting events update both the world fact graph and the narrative significance graph.

This is the persistent memory write phase.

Update examples:

- relationship strength changes
- control of locations shifts
- unresolved vengeance thread activates
- foreshadow node created from a revealed omen
- chapter-worthy tension score increases

### 5. Narrative director selection

Not every resolved event becomes chapter material. The director layer scores and selects chapter candidates.

Selection criteria should include:

- conflict intensity
- magnitude of relationship change
- long-thread activation
- irreversible consequence
- secrecy, revelation, or misdirection value
- emotional threshold crossing
- ensemble balance and recency

### 6. Dual output generation

The system emits two artifacts.

Internal artifact:

- world-state log
- complete structured event record
- state changes and affected graph regions

Reader-facing artifact:

- one chapter or scene package
- centered around one primary POV, optionally one supporting POV
- focused on selected events rather than the whole world

## Character Decision Model

Each major `Character` should include at least:

- `core_desires`
- `short_term_goals`
- `taboos`
- `resources`
- `beliefs`
- `hidden_truths`
- `emotional_vectors`
- `public_identity`
- `private_identity`

Example character drivers in xianxia:

- seek immortality
- protect junior sibling
- avenge clan destruction
- seize sect succession
- conceal bloodline
- preserve righteousness facade

The actor engine should not directly script a plot. It should produce ranked candidate actions from the character’s motivations and limits. A character should usually execute one or two major actions per turn, selected from candidates by:

- desire strength
- urgency
- opportunity fit
- risk tolerance
- personality bias
- available resources

## Faction Decision Model

Each major `Faction` should include:

- `agenda`
- `constraints`
- `doctrine`
- `internal_blocks`
- `strategic_targets`
- `public_posture`
- `hidden_operations`

Faction actions should evolve slower than character actions but exert broader pressure.

Examples:

- annex territory
- suppress scandal
- recruit a genius disciple
- cover up a forbidden technique leak
- ally temporarily against a common enemy
- purge a wavering elder line

Faction turns should shape the world’s macro direction even when no single chapter focuses on them.

## Narrative Director Layer

This layer is essential. Without it, the system produces a world chronicle instead of a novel.

Responsibilities:

1. choose the most narratively valuable events from the turn
2. pick primary POV and optional secondary POV
3. decide how much to reveal now vs defer
4. balance chapter rhythm across the ensemble
5. ensure the chapter has a hook, progression, and closing tension

The director should maintain narrative meta-state such as:

- top active long-running threads
- underused ensemble characters worth returning to
- unresolved foreshadow and secrets
- recent chapter pacing distribution
- currently overheated or neglected conflict zones

### POV policy

For ensemble fiction, each chapter should generally prefer:

- one primary POV
- at most one secondary POV

The best POV is not always the strongest actor. It is the actor for whom the selected event has the highest emotional, strategic, or identity consequence.

## Chapter Generator

The chapter generator should not receive the entire world. It should receive a constrained packet assembled by the director layer.

Recommended input packet:

- selected event bundle
- primary POV
- optional secondary POV
- active tension summary
- recalled relationship history
- unresolved secrets relevant to this POV
- tone and pacing target for this chapter
- chapter end hook target

Recommended output:

- reader-facing prose chapter
- chapter summary
- list of factual claims emitted in prose for consistency back-checking

## Memory and Recall Adaptation

The existing `graph-memory` repository can contribute directly in these areas:

- SQLite-backed graph persistence
- node and edge search
- vector recall
- graph walk expansion
- ranking and community grouping
- maintenance cycles such as deduplication and graph scoring

It should be adapted to narrative use as follows:

- replace agent-oriented node and edge ontology
- replace extraction prompts with narrative-state extraction and event recording prompts
- replace OpenClaw assemble flow with simulation and chapter context assembly
- rank recall by narrative relevance, causality, relationship proximity, and thread activation
- favor episodic recall for prior interactions between current POV and involved entities

In the novel system, recall should answer:

- what this POV has been through with these people
- what promises, grudges, debts, or secrets are still active
- what artifacts or locations matter to the current conflict
- what prior threads this event might awaken or resolve

## MVP Scope

The first implementation phase should be a closed-loop prototype with six modules.

The initial world bootstrap path should also be mixed:

- a hand-authored seed package should define the starting cultivation world, major factions, core characters, rules, and tone
- selective model-assisted generation may expand secondary details from that seed package
- the MVP should not depend on fully automatic world bootstrapping to function

### 1. `WorldState`

Responsibilities:

- persist world entities and relationships
- store truth-state and actor belief-state
- expose structured queries for simulator and director

### 2. `TurnSimulator`

Responsibilities:

- advance time
- process ongoing world effects
- collect candidate actions
- resolve resulting events

### 3. `ActorDecisionEngine`

Responsibilities:

- produce ranked candidate actions for major characters and factions
- operate on local goals plus subjective knowledge

### 4. `NarrativeDirector`

Responsibilities:

- score event bundles
- choose POV and chapter focus
- manage ensemble rhythm and unresolved threads

### 5. `ChapterGenerator`

Responsibilities:

- convert selected narrative packet into chapter prose
- emit structured chapter metadata for later checking

### 6. `MemoryConsistencyLayer`

Responsibilities:

- recall relevant prior state
- surface unresolved threads
- detect factual contradictions before or after chapter generation

## MVP Success Criteria

The MVP is successful if it can:

- initialize a cultivation world with multiple major characters and factions
- run for 20 to 50 turns without collapsing into incoherence
- emit a structured world log every turn
- select chapter-worthy developments every turn
- generate reader-facing prose on a configurable cadence, with the MVP default set to every 3 turns
- generate readable chapter prose from chosen developments
- preserve consistency across characters, relationships, artifacts, and locations
- carry long-running threads across many turns instead of resetting focus each cycle

## Explicit MVP Cuts

Do not build these in phase one:

- full independent simulation for all minor NPCs
- deep tactical combat engine
- detailed economy simulator
- giant map-scale real-time simulation
- full production workflow for book-length publishing

## Risks

### 1. Emergence without readability

Risk:

- the world becomes rich but chapters feel like reports

Mitigation:

- keep the narrative director as a first-class layer
- strongly constrain chapter focus and POV

### 2. Readability without real emergence

Risk:

- chapters become polished but secretly rely on plot forcing

Mitigation:

- keep chapter input grounded in resolved world events
- log all narrative selections back to world state

### 3. Ensemble sprawl

Risk:

- too many characters dilute continuity

Mitigation:

- track active ensemble window
- rotate spotlight intentionally

### 4. Consistency drift

Risk:

- generated prose contradicts world state

Mitigation:

- structured recall packets
- chapter claim extraction
- consistency validation pass

## Testing Strategy

The implementation should eventually be tested at four levels.

### Unit tests

- entity and relationship storage
- turn settlement rules
- candidate action ranking
- event resolution
- recall and ranking

### Simulation tests

- multi-turn persistence
- relationship evolution
- thread activation and resolution
- belief divergence and mistaken action outcomes

### Narrative tests

- chapter candidate scoring
- POV selection
- hook and payoff handling
- ensemble balance over multiple chapters

### Consistency tests

- artifact ownership continuity
- location continuity
- relationship contradiction detection
- unresolved secret persistence

## Recommended Implementation Order

1. define new narrative ontology and storage model
2. build `WorldState`
3. build `ActorDecisionEngine`
4. build `TurnSimulator`
5. build `NarrativeDirector`
6. build `MemoryConsistencyLayer`
7. build `ChapterGenerator`
8. add consistency validation and chapter claim checking

## Architecture Decision

The recommended architecture is:

- open-ended world simulation at the core
- mixed character and faction drivers
- turn-based progression
- separate truth-state and subjective belief-state
- dual graph model for world facts and narrative significance
- dual outputs for internal logs and reader-facing chapters
- narrative director as a mandatory layer between simulation and prose

This direction preserves emergence while keeping the system capable of producing coherent fiction instead of a raw chronicle.
