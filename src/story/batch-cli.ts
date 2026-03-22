import { closeDb, getDb } from "../store/db.ts";
import { loadStoryConfig } from "./config.ts";
import { buildRunId, readOutputDirArg, readTurnsArg } from "./cli.ts";
import { writeRunBundle } from "./output/run-bundle.ts";
import { createStoryModelClient } from "./runtime/model-client.ts";
import { createStubStoryModelClient } from "./runtime/stub-model.ts";
import { runStoryLoop } from "./runtime/run-loop.ts";

export async function runStoryBatchCli(argv: string[] = process.argv.slice(2)) {
  process.env.NOVEL_RESET_ON_START = "1";

  const useStubModel = argv.includes("--stub-model");
  const runs = readRunsArg(argv);
  const turns = readTurnsArg(argv);
  const outputDir = readOutputDirArg(argv);
  const failOnRun = readFailOnRunArg(argv);
  const cfg = loadStoryConfig({ allowMissingLlmEnv: useStubModel });

  for (let runNumber = 1; runNumber <= runs; runNumber += 1) {
    if (failOnRun === runNumber) {
      console.error(`run=${runNumber}`);
      throw new Error(`[story-runtime] configured batch failure at run=${runNumber}`);
    }

    const startedAt = new Date().toISOString();
    const db = getDb(cfg.dbPath);

    try {
      const model = useStubModel ? createStubStoryModelClient() : createStoryModelClient(cfg.llm);
      const result = await runStoryLoop(db, { turns, model });
      const finishedAt = new Date().toISOString();
      const bundle = await writeRunBundle(db, result, {
        outputRoot: outputDir,
        runMetadata: {
          runId: buildRunId(startedAt),
          turns,
          chapterEveryTurns: cfg.chapterEveryTurns,
          dbPath: cfg.dbPath,
          resetOnStart: cfg.resetOnStart,
          model: useStubModel
            ? { mode: "stub", name: "stub-story-model" }
            : { mode: cfg.llm.mode, name: cfg.llm.model },
          startedAt,
          finishedAt,
        },
      });

      console.log(`run=${runNumber} bundle=${bundle.bundlePath} turns=${bundle.turnCount} chapters=${bundle.chapterCount}`);
    } finally {
      closeDb();
    }
  }

  console.log(`runs=${runs}`);
}

if (import.meta.main) {
  runStoryBatchCli().catch((err) => {
    console.error("Story batch CLI failed:", err);
    process.exit(1);
  });
}

function readRunsArg(argv: string[]): number {
  const runsArg = argv.find((arg) => arg.startsWith("--runs="));
  if (!runsArg) return 1;
  const parsed = Number(runsArg.slice("--runs=".length));
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("[story-runtime] --runs must be a positive integer");
  }
  return parsed;
}

function readFailOnRunArg(argv: string[]): number | undefined {
  const failOnRunArg = argv.find((arg) => arg.startsWith("--fail-on-run="));
  if (!failOnRunArg) return undefined;
  const parsed = Number(failOnRunArg.slice("--fail-on-run=".length));
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("[story-runtime] --fail-on-run must be a positive integer");
  }
  return parsed;
}
