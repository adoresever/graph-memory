# World-Sim Phase 2 Run Bundles Design

## Goal

Turn the current xianxia world-sim MVP into a usable novel-production surface by exporting each simulation run as a stable filesystem bundle and adding a batch-oriented entrypoint for multi-chapter generation.

Phase 2 deliberately builds on the Task 1-9 runtime instead of replacing it. The world model, turn loop, director state, chapter generation, and consistency validation already form a working closed loop. What is still missing for an automatic novel system is an external artifact layer that lets us:

- inspect a run after it finishes
- feed generated chapters into downstream writing flows
- compare runs over time
- resume or branch from a chosen run later

## Product Direction

Phase 2 focuses on two subprojects, in this order:

1. **Run bundle export layer**
   Each execution produces a self-contained directory under `runs/<run-id>/` with chapter markdown, world logs, final state snapshots, and a machine-readable index.

2. **Batch execution layer**
   A CLI entrypoint drives repeated or longer story generation runs while writing each run into the export format above.

This keeps the system practical for the intended use case: automatic xianxia novel production with inspectable intermediate state.

## Why This Direction

The current runtime is already good enough to simulate turns and emit chapters, but its outputs are still mostly trapped inside stdout and SQLite tables. That is acceptable for a technical MVP, but not for a production-facing story workflow.

For the user’s intended system, filesystem artifacts are not an afterthought. They are the primary interface between:

- the simulation core
- future outline/planning tools
- future prose polishing tools
- human review
- version control

Because of that, Phase 2 should prioritize durable outputs over adding more world complexity first.

## Alternatives Considered

### Option A: Run-bundle export plus batch runner

Each run gets its own directory, such as:

```text
runs/<run-id>/
  index.json
  world-log.jsonl
  chapters/
    chapter-001.md
    chapter-002.md
  state/
    final-world.json
    final-director.json
    consistency.json
```

**Pros**

- preserves history across runs
- easy to inspect manually
- easy to feed into downstream tooling
- natural fit for git and local filesystem workflows
- supports future resume/branch features

**Cons**

- introduces file layout and serialization decisions
- requires an output layer in addition to SQLite persistence

### Option B: Single rolling output directory

Write the latest results into one fixed directory like `output/`.

**Pros**

- simplest implementation
- good for quick demos

**Cons**

- destroys prior run history
- weak fit for long-form novel experimentation
- makes regression analysis and branching harder

### Option C: Database-only workflow

Keep everything in SQLite and expose more query commands instead of exporting files.

**Pros**

- minimal new storage surface
- low duplication

**Cons**

- inconvenient for chapter review and editing
- poor handoff format for downstream writing tools
- harder to diff and archive

### Recommendation

Use **Option A**. It best matches an automatic novel system where runs are assets, not ephemeral logs.

## Scope Boundaries

Phase 2 is intentionally narrow.

Included:

- stable run output structure
- deterministic chapter file naming
- machine-readable run index
- final state snapshot export
- batch-capable CLI surface

Not included:

- new world simulation rules
- major schema redesign
- branching/resume from historical runs
- style polishing or rewriting chapters
- chapter-to-chapter global arc planner

Those can come later once the export and batch surfaces exist.

## Architecture

### Core Principle

Keep simulation and export separate.

The runtime continues to own:

- turn progression
- chapter cadence
- director state evolution
- consistency validation

The new export layer owns:

- run ids
- output directories
- serialization formats
- writing chapters and state snapshots to disk

The CLI orchestrates both layers but should not absorb export formatting logic directly.

### Proposed Units

#### `src/story/runtime/run-loop.ts`

Remains the source of truth for in-process run results. It should continue returning structured data that export code can consume directly.

#### `src/story/output/run-bundle.ts`

New module responsible for:

- creating `runs/<run-id>/`
- writing `index.json`
- appending `world-log.jsonl`
- writing chapter markdown files
- writing final state snapshots

This module should take a completed `StoryLoopResult` plus configuration metadata and produce a `RunBundleSummary`.

Boundary rule:

- `runStoryLoop()` remains responsible only for runtime execution results
- the exporter is allowed to read final persisted state from SQLite after the run completes
- `final-world.json` should therefore come from a fresh database-backed world snapshot captured during export, not from inflating `StoryLoopResult` to include every persisted table

This keeps simulation and export separate while still making the final world artifact concrete.

#### `src/story/output/serializers.ts`

New module for formatting:

- chapter markdown headers/body
- world log JSONL rows
- final state JSON payloads

This keeps formatting concerns out of the CLI and bundle writer.

#### `src/story/cli.ts`

Continues to support single-run execution, but gains explicit export behavior so a normal story run produces a run bundle.

#### `src/story/batch-cli.ts`

New entrypoint for controlled repeated execution, for example:

```bash
npm run story:batch -- --runs=3 --turns=30 --stub-model
```

The batch CLI should call the existing run pipeline once per run and write a new run bundle each time.

## Data Model For Run Bundles

### Run ID

Each run should get a stable unique id, preferably timestamp-based plus a short suffix, for example:

```text
2026-03-22T21-30-15Z-a1b2c
```

The exact format matters less than these properties:

- filesystem-safe
- sortable by time
- unique across repeated invocations

### Directory Layout

```text
runs/<run-id>/
  index.json
  world-log.jsonl
  chapters/
    chapter-001.md
    chapter-002.md
  state/
    final-world.json
    final-director.json
    consistency.json
```

### `index.json`

Should contain the summary needed by humans and programs:

- schema version
- run id
- started/finished timestamps
- turn count
- chapter count
- db path
- reset mode
- chapter cadence
- model mode
- model name
- output paths
- consistency issue count

This file is the canonical “manifest” for the run.
It should include a version field such as `schemaVersion: 1` so downstream tooling can evolve safely.

### `world-log.jsonl`

One JSON object per turn. This is better than one large JSON array because:

- it streams naturally
- it is easy to inspect incrementally
- future long runs will not require rewriting the whole file

### Chapter Files

Each chapter should be written as markdown:

```markdown
# Chapter 001

- Run: <run-id>
- Turn: 3
- Summary: ...

<chapter prose>
```

The chapter files are the most human-facing output and should be easy to browse in a vault, editor, or git diff.

### Final State Snapshots

Store at least:

- final world snapshot
- final director state
- consistency issues

This makes downstream analysis possible without reopening the database.

Source-of-truth rule:

- `final-world.json` comes from a database-backed world snapshot captured after the run finishes
- `final-director.json` comes from `StoryLoopResult.finalDirectorState`
- `consistency.json` comes from `StoryLoopResult.consistencyIssues`

## CLI Design

### Single-Run CLI

Existing `story:run` should evolve from “run and print counters” to “run, export, and print bundle summary”.

Expected stdout should still remain concise:

- `turns=...`
- `chapters=...`
- `bundle=...`
- `db=...`
- `resetOnStart=...`

This preserves the current script ergonomics while making the exported bundle discoverable.

### Batch CLI

New command shape:

```bash
npm run story:batch -- --runs=3 --turns=30 --stub-model
```

Recommended first-pass semantics:

- each batch item is an independent run bundle
- Phase 2 batch mode must isolate runs from one another by default
- each batch item should therefore begin from cleared runtime state
- carry-over continuation between batch items is explicitly out of scope for this phase
- batch stdout prints one summary line per run plus a final aggregate summary

The first Phase 2 batch runner should stay intentionally simple. It does not need resume, branching, or fancy scheduling yet.

## Error Handling

### Export Failures

If export fails after the runtime completes, the CLI should:

- keep the database results intact
- report a clear filesystem/export error
- avoid pretending the run bundle exists when it does not

The export layer should write files in a deterministic order so partial failure is easier to diagnose.

### Batch Failures

For the first pass, batch execution should default to fail-fast:

- stop on the first failed run
- print which run failed
- keep already-written bundles

Later phases can add `--continue-on-error` if needed.

## Testing Strategy

### Export Tests

Add focused tests that verify:

- run bundle directories are created
- chapter files are written with stable names
- `index.json` contains the expected metadata
- `world-log.jsonl` line count matches turn count

### CLI Integration Tests

Add end-to-end CLI tests that verify:

- `story:run` creates one run bundle
- `story:batch` creates multiple run bundles
- stub model mode works without live credentials

### Existing Runtime Regression Coverage

Continue to rely on the Task 1-9 story suite for:

- world initialization
- turn simulation
- memory recall
- director logic
- chapter generation
- long-run consistency

Phase 2 should add export/batch coverage, not duplicate the whole runtime test matrix.

## Risks And Mitigations

### Risk: CLI grows too large

Mitigation:

- move export logic into `src/story/output/*`
- keep CLI focused on argument parsing and orchestration

### Risk: Output schema churn breaks downstream tools

Mitigation:

- make `index.json` the stable contract
- keep chapter markdown human-friendly but not the only machine interface

### Risk: Batch mode silently mixes runs together

Mitigation:

- one directory per run
- unique run ids
- explicit manifest per run

## Success Criteria

Phase 2 subproject A is successful when:

- a single `story:run` execution creates a complete run bundle
- a new engineer can inspect the generated chapters and state without opening SQLite

Phase 2 subproject B is successful when:

- a single batch command creates multiple independent run bundles
- stub model mode supports local batch testing without secrets

## Recommended Execution Order

1. Add run bundle exporter and serializers
2. Wire single-run CLI export
3. Add run bundle integration tests
4. Add batch CLI entrypoint
5. Add batch integration tests
6. Document batch usage and output contract

## Next Step

The next artifact should be a dedicated implementation plan for Phase 2, starting with subproject A (run bundle export layer) and then subproject B (batch execution layer).
