# World-Sim Phase 2 Run Bundles And Batch CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable run-bundle exports and a batch-oriented CLI so the xianxia story simulator produces reusable filesystem artifacts for downstream novel workflows.

**Architecture:** Keep the existing runtime loop as the source of simulation truth, then layer file export and batch orchestration on top. Single-run and batch CLIs should both reuse a shared stub-model helper and a dedicated run-bundle writer so output format stays stable across entrypoints.

**Tech Stack:** TypeScript, Node.js filesystem APIs, existing SQLite-backed story runtime, Vitest, execa

---

## File Structure

### New Files

- `src/story/runtime/stub-model.ts`
  - Shared stub `StoryModelClient` used by both `story:run` and `story:batch`
- `src/story/output/serializers.ts`
  - Pure formatting helpers for chapter markdown, world-log JSONL rows, and run index payloads
- `src/story/output/run-bundle.ts`
  - Creates `runs/<run-id>/` bundles and writes all exported artifacts
- `src/story/batch-cli.ts`
  - Batch-oriented CLI entrypoint for repeated isolated runs
- `test/story/run-bundle.test.ts`
  - Focused export-layer tests
- `test/story/batch-cli.test.ts`
  - End-to-end batch CLI tests

### Modified Files

- `src/story/cli.ts`
  - Use shared stub model and export run bundles after single-run execution
- `package.json`
  - Add `story:batch` and any test script needed for batch verification
- `README.md`
  - Document run-bundle layout and batch CLI usage
- `test/story/cli.test.ts`
  - Verify `story:run` now emits a run bundle path and writes files

### Existing Files To Reuse

- `src/story/runtime/run-loop.ts`
  - Runtime execution surface returning `StoryLoopResult`
- `src/story/memory/consistency.ts`
  - Provides `buildStoryWorldSnapshot(db)` for `final-world.json`
- `src/store/db.ts`
  - `getDb()` / `closeDb()` for real CLI database access

---

### Task 1: Add Export-Layer Failing Tests And Shared Stub Model

**Files:**
- Create: `src/story/runtime/stub-model.ts`
- Create: `test/story/run-bundle.test.ts`

- [ ] **Step 1: Write the failing run-bundle tests**

```ts
it("writes a complete run bundle with manifest, chapters, and final state files", async () => {
  const db = createTestDb();
  initializeStoryWorld(db);
  const result = await runStoryLoop(db, { turns: 3, model: createStubStoryModelClient() });

  const bundle = await writeRunBundle(db, result, {
    outputRoot: tempRoot,
    turns: 3,
    chapterEveryTurns: 3,
    dbPath: "/tmp/story.db",
    resetOnStart: true,
    model: { mode: "stub", name: "stub-story-model" },
  });

  expect(existsSync(join(bundle.bundlePath, "index.json"))).toBe(true);
  expect(existsSync(join(bundle.bundlePath, "world-log.jsonl"))).toBe(true);
  expect(existsSync(join(bundle.bundlePath, "chapters", "chapter-001.md"))).toBe(true);
  expect(existsSync(join(bundle.bundlePath, "state", "final-world.json"))).toBe(true);
  expect(existsSync(join(bundle.bundlePath, "state", "final-director.json"))).toBe(true);
  expect(existsSync(join(bundle.bundlePath, "state", "consistency.json"))).toBe(true);
});
```

- [ ] **Step 2: Run the run-bundle test to verify it fails**

Run: `npx vitest run test/story/run-bundle.test.ts`
Expected: FAIL because `writeRunBundle()` and the shared stub model do not exist yet.

- [ ] **Step 3: Add the shared stub model helper**

```ts
export function createStubStoryModelClient(): StoryModelClient {
  return {
    rerankActorActions: async (actions) => actions,
    rerankFactionActions: async (actions) => actions,
    rerankChapterFocus: async (candidates) => candidates,
    generateChapter: async (packet) =>
      `Stub chapter turn ${packet.turnNumber} focus ${packet.focus}. ${packet.summary ?? ""}`.trim(),
    summarizeTurn: async (input) =>
      `Stub turn ${input.turnNumber}: ${input.highlights.join("; ") || "no-highlights"}`,
    extractClaims: async () => [],
  };
}
```

- [ ] **Step 4: Re-run the run-bundle test**

Run: `npx vitest run test/story/run-bundle.test.ts`
Expected: FAIL, but now specifically because the run-bundle writer/export layer is still missing.

- [ ] **Step 5: Commit the red-test scaffold**

```bash
git add src/story/runtime/stub-model.ts test/story/run-bundle.test.ts
git commit -m "test: add run bundle export coverage"
```

### Task 2: Implement Serializers And Run-Bundle Writer

**Files:**
- Create: `src/story/output/serializers.ts`
- Create: `src/story/output/run-bundle.ts`
- Modify: `test/story/run-bundle.test.ts`

- [ ] **Step 1: Extend the failing export tests to pin output content**

```ts
expect(JSON.parse(readFileSync(join(bundle.bundlePath, "index.json"), "utf8"))).toMatchObject({
  schemaVersion: 1,
  turnCount: 3,
  chapterCount: 1,
  consistencyIssueCount: 0,
});

expect(readFileSync(join(bundle.bundlePath, "chapters", "chapter-001.md"), "utf8")).toContain("# Chapter 001");
expect(readFileSync(join(bundle.bundlePath, "world-log.jsonl"), "utf8").trim().split("\n")).toHaveLength(3);
```

- [ ] **Step 2: Run the test to verify it still fails**

Run: `npx vitest run test/story/run-bundle.test.ts`
Expected: FAIL because no exporter implementation exists.

- [ ] **Step 3: Implement serializer helpers**

```ts
export function formatChapterMarkdown(input: {
  chapterNumber: number;
  runId: string;
  turnNumber: number;
  summary: string;
  prose: string;
}): string {
  return [
    `# Chapter ${String(input.chapterNumber).padStart(3, "0")}`,
    "",
    `- Run: ${input.runId}`,
    `- Turn: ${input.turnNumber}`,
    `- Summary: ${input.summary}`,
    "",
    input.prose,
    "",
  ].join("\n");
}
```

- [ ] **Step 4: Implement the run-bundle writer**

```ts
export async function writeRunBundle(
  db: DatabaseSyncInstance,
  result: StoryLoopResult,
  meta: RunBundleMeta,
): Promise<RunBundleSummary> {
  const runId = createRunId();
  const bundlePath = join(meta.outputRoot, runId);
  mkdirSync(join(bundlePath, "chapters"), { recursive: true });
  mkdirSync(join(bundlePath, "state"), { recursive: true });

  writeFileSync(join(bundlePath, "world-log.jsonl"), result.worldLogs.map(formatWorldLogLine).join("\n") + "\n");
  writeFileSync(join(bundlePath, "state", "final-world.json"), JSON.stringify(buildStoryWorldSnapshot(db), null, 2));
  writeFileSync(join(bundlePath, "state", "final-director.json"), JSON.stringify(result.finalDirectorState, null, 2));
  writeFileSync(join(bundlePath, "state", "consistency.json"), JSON.stringify(result.consistencyIssues, null, 2));
  writeFileSync(join(bundlePath, "index.json"), JSON.stringify(buildRunIndex(...), null, 2));

  return { runId, bundlePath, chapterCount: result.chapters.length, turnCount: result.worldLogs.length };
}
```

- [ ] **Step 5: Run the run-bundle test to verify it passes**

Run: `npx vitest run test/story/run-bundle.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/story/output/serializers.ts src/story/output/run-bundle.ts test/story/run-bundle.test.ts
git commit -m "feat: add story run bundle exporter"
```

### Task 3: Wire Single-Run CLI To Export Bundles

**Files:**
- Modify: `src/story/cli.ts`
- Modify: `test/story/cli.test.ts`

- [ ] **Step 1: Write the failing single-run CLI export test**

```ts
it("exports a run bundle and prints its path", async () => {
  const outputRoot = mkdtempSync("/tmp/story-run-bundle-");
  const result = await execa("npm", [
    "run",
    "story:run",
    "--",
    "--turns=3",
    "--stub-model",
    `--output-dir=${outputRoot}`,
  ], { cwd: repoRoot, env: { ...process.env, NOVEL_RESET_ON_START: "1" } });

  expect(result.stdout).toContain("turns=3");
  expect(result.stdout).toContain("chapters=1");
  expect(result.stdout).toContain("bundle=");
});
```

- [ ] **Step 2: Run the CLI test to verify it fails**

Run: `npx vitest run test/story/cli.test.ts`
Expected: FAIL because `story:run` does not yet export run bundles or print `bundle=...`.

- [ ] **Step 3: Implement single-run export wiring**

```ts
const outputRoot = readOutputDirArg(argv) ?? join(process.cwd(), "runs");
const model = useStubModel ? createStubStoryModelClient() : createStoryModelClient(cfg.llm);
const result = await runStoryLoop(db, { turns, model });
const bundle = await writeRunBundle(db, result, {
  outputRoot,
  turns,
  chapterEveryTurns: cfg.chapterEveryTurns,
  dbPath: cfg.dbPath,
  resetOnStart: cfg.resetOnStart,
  model: useStubModel ? { mode: "stub", name: "stub-story-model" } : { mode: cfg.llm.mode, name: cfg.llm.model },
});
console.log(`bundle=${bundle.bundlePath}`);
```

- [ ] **Step 4: Re-run the CLI tests**

Run: `npx vitest run test/story/cli.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/story/cli.ts test/story/cli.test.ts
git commit -m "feat: export single story runs as bundles"
```

### Task 4: Add Batch CLI Failing Tests

**Files:**
- Create: `test/story/batch-cli.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing batch CLI tests**

```ts
it("creates one isolated run bundle per batch item", async () => {
  const outputRoot = mkdtempSync("/tmp/story-batch-");
  const result = await execa("npm", [
    "run",
    "story:batch",
    "--",
    "--runs=2",
    "--turns=3",
    "--stub-model",
    `--output-dir=${outputRoot}`,
  ], { cwd: repoRoot, env: { ...process.env } });

  expect(result.stdout).toContain("runs=2");
  expect(readdirSync(outputRoot).length).toBe(2);
});
```

- [ ] **Step 2: Add the package script placeholder**

```json
{
  "scripts": {
    "story:batch": "node --import tsx src/story/batch-cli.ts"
  }
}
```

- [ ] **Step 3: Run the batch CLI test to verify it fails**

Run: `npx vitest run test/story/batch-cli.test.ts`
Expected: FAIL because `src/story/batch-cli.ts` does not exist yet.

- [ ] **Step 4: Add the failing batch fail-fast test**

```ts
it("stops the batch on the first failing run and reports which run failed", async () => {
  const result = await execa("npm", [
    "run",
    "story:batch",
    "--",
    "--runs=3",
    "--turns=3",
    "--fail-on-run=2",
    "--stub-model",
  ], { cwd: repoRoot, reject: false });

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("run=2");
});
```

- [ ] **Step 5: Re-run the batch CLI test to verify it fails for the right reason**

Run: `npx vitest run test/story/batch-cli.test.ts`
Expected: FAIL because batch CLI behavior is still unimplemented.

- [ ] **Step 6: Commit the failing batch tests**

```bash
git add package.json test/story/batch-cli.test.ts
git commit -m "test: add batch story cli coverage"
```

### Task 5: Implement Batch CLI And Shared Argument Parsing

**Files:**
- Create: `src/story/batch-cli.ts`
- Modify: `src/story/cli.ts`
- Modify: `package.json`
- Modify: `test/story/batch-cli.test.ts`

- [ ] **Step 1: Implement the batch CLI**

```ts
for (let runIndex = 0; runIndex < runs; runIndex += 1) {
  const db = getDb(cfg.dbPath);
  try {
    const result = await runStoryLoop(db, { turns, model });
    const bundle = await writeRunBundle(db, result, metaForRun(runIndex));
    console.log(`run=${runIndex + 1} bundle=${bundle.bundlePath} turns=${bundle.turnCount} chapters=${bundle.chapterCount}`);
  } finally {
    closeDb();
  }
}
console.log(`runs=${runs}`);
```

- [ ] **Step 2: Make batch isolation explicit**

```ts
process.env.NOVEL_RESET_ON_START = "1";
```

or equivalent argument/config handling that guarantees each batch item starts from cleared runtime state.

- [ ] **Step 3: Implement fail-fast batch errors**

```ts
try {
  // run one batch item
} catch (error) {
  console.error(`run=${runIndex + 1} failed`, error);
  process.exitCode = 1;
  break;
}
```

- [ ] **Step 4: Run the batch CLI tests**

Run: `npx vitest run test/story/batch-cli.test.ts`
Expected: PASS

- [ ] **Step 5: Re-run single-run CLI tests to catch regressions**

Run: `npx vitest run test/story/cli.test.ts test/story/batch-cli.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/story/batch-cli.ts src/story/cli.ts package.json test/story/batch-cli.test.ts
git commit -m "feat: add batch story run bundles"
```

### Task 6: Document Run Bundles And Batch Workflow

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Write the failing documentation expectation checklist**

Manually verify the README draft covers:

- run-bundle directory layout
- `story:run` with `--output-dir`
- `story:batch` with `--runs` and `--turns`
- stub-model usage without live credentials
- separation between run bundles and SQLite persistence

- [ ] **Step 2: Update README.md**

Add a dedicated “Run Bundles And Batch Generation” section with examples:

```bash
npm run story:run -- --turns=3 --stub-model --output-dir=./runs
npm run story:batch -- --runs=2 --turns=6 --stub-model --output-dir=./runs
```

Include the exact exported structure:

```text
runs/<run-id>/
  index.json
  world-log.jsonl
  chapters/
  state/
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add run bundle and batch workflow"
```

### Task 7: Cover Export Failure Behavior

**Files:**
- Modify: `test/story/cli.test.ts`
- Modify: `src/story/cli.ts`

- [ ] **Step 1: Write the failing export-error CLI test**

```ts
it("fails clearly when bundle export cannot be written", async () => {
  const result = await execa("npm", [
    "run",
    "story:run",
    "--",
    "--turns=3",
    "--stub-model",
    "--output-dir=/dev/null/story-output",
  ], { cwd: repoRoot, reject: false });

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Story CLI failed:");
  expect(result.stdout).not.toContain("bundle=");
});
```

- [ ] **Step 2: Run the CLI suite to verify it fails**

Run: `npx vitest run test/story/cli.test.ts`
Expected: FAIL because export failures are not yet handled as an explicit contract.

- [ ] **Step 3: Implement explicit export failure handling**

Ensure `story:run`:

- never prints `bundle=` unless `writeRunBundle()` succeeds
- surfaces a clear export error through the existing CLI failure path
- leaves runtime persistence untouched by not attempting cleanup of already-written DB results

- [ ] **Step 4: Re-run the CLI suite**

Run: `npx vitest run test/story/cli.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/story/cli.ts test/story/cli.test.ts
git commit -m "fix: harden story cli export failures"
```

### Task 8: Full Verification

**Files:**
- Verify only

- [ ] **Step 1: Run focused export and CLI suites**

Run: `npx vitest run test/story/run-bundle.test.ts test/story/cli.test.ts test/story/batch-cli.test.ts`
Expected: PASS

- [ ] **Step 2: Run the full story suite**

Run: `npm run test:story`
Expected: PASS

- [ ] **Step 3: Run the full repository suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Run the build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 5: Verify single-run bundle output manually**

Run:

```bash
tmp_out=$(mktemp -d /tmp/story-phase2-run-XXXXXX)
npm run story:run -- --turns=3 --stub-model --output-dir="$tmp_out"
```

Expected:

- stdout contains `turns=3`
- stdout contains `chapters=1`
- stdout contains `bundle=`
- exactly one run directory is created under `$tmp_out`

- [ ] **Step 6: Verify batch bundle output manually**

Run:

```bash
tmp_out=$(mktemp -d /tmp/story-phase2-batch-XXXXXX)
npm run story:batch -- --runs=2 --turns=6 --stub-model --output-dir="$tmp_out"
```

Expected:

- stdout contains `runs=2`
- two run directories are created
- each run directory contains `index.json`, `world-log.jsonl`, `chapters/`, and `state/`

- [ ] **Step 7: Verify batch fail-fast behavior manually**

Run:

```bash
tmp_out=$(mktemp -d /tmp/story-phase2-batch-fail-XXXXXX)
npm run story:batch -- --runs=3 --turns=3 --stub-model --fail-on-run=2 --output-dir="$tmp_out"
```

Expected:

- command exits non-zero
- stderr identifies `run=2`
- only the completed run bundles before the failure remain on disk

- [ ] **Step 8: Commit any final verification-only adjustments**

```bash
git add README.md package.json src/story/cli.ts src/story/batch-cli.ts src/story/output/serializers.ts src/story/output/run-bundle.ts src/story/runtime/stub-model.ts test/story/cli.test.ts test/story/batch-cli.test.ts test/story/run-bundle.test.ts
git commit -m "chore: finalize phase 2 run bundle rollout"
```

## Verification Checklist

Before calling Phase 2 subprojects A+B complete, verify all of the following:

- `test/story/run-bundle.test.ts` passes
- `test/story/cli.test.ts` passes
- `test/story/batch-cli.test.ts` passes
- `npm run test:story` passes
- `npm test` passes
- `npm run build` passes
- `story:run` writes a complete bundle with one run directory
- `story:batch` writes one isolated bundle per batch item
- batch mode stops on the first failed run and reports which run failed
- `index.json` includes `schemaVersion`
- `final-world.json` comes from a database-backed world snapshot
- no committed file contains real `NOVEL_LLM_API_KEY` values or hard-coded production secrets
- README is sufficient for a new engineer to run and inspect bundles locally
