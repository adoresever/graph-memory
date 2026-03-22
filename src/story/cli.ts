import { randomBytes } from "node:crypto";
import path from "node:path";
import { closeDb, getDb } from "../store/db.ts";
import { loadStoryConfig } from "./config.ts";
import {
  createStoryModelClient,
} from "./runtime/model-client.ts";
import { createStubStoryModelClient } from "./runtime/stub-model.ts";
import { runStoryLoop } from "./runtime/run-loop.ts";
import { writeRunBundle } from "./output/run-bundle.ts";

export async function runStoryCli(argv: string[] = process.argv.slice(2)) {
  const useStubModel = argv.includes("--stub-model");
  const cfg = loadStoryConfig({ allowMissingLlmEnv: useStubModel });
  const turns = readTurnsArg(argv);
  const outputDir = readOutputDirArg(argv);

  console.log("Story runtime configuration loaded:");
  console.log(`  mode=${cfg.llm.mode} model=${cfg.llm.model}`);
  if (cfg.resetOnStart) {
    console.log("  resetOnStart=true (runtime state will be cleared)");
  }
  console.log(`  dbPath=${cfg.dbPath}`);
  console.log("Arguments:", argv.join(" "));

  if (argv.includes("--dry-run")) {
    const previewModel = useStubModel ? createStubStoryModelClient() : createStoryModelClient(cfg.llm);
    console.log("Model client initialized with baseURL:", cfg.llm.baseURL || "(not set)");
    return previewModel;
  }

  const db = getDb(cfg.dbPath);
  try {
    const startedAt = new Date().toISOString();
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
    console.log(`turns=${result.worldLogs.length}`);
    console.log(`chapters=${result.chapters.length}`);
    console.log(`bundle=${bundle.bundlePath}`);
    console.log(`db=${cfg.dbPath}`);
    console.log(`resetOnStart=${cfg.resetOnStart ? "1" : "0"}`);
    return result;
  } finally {
    closeDb();
  }
}

if (import.meta.main) {
  runStoryCli().catch((err) => {
    console.error("Story CLI failed:", err);
    process.exit(1);
  });
}

export function readTurnsArg(argv: string[]): number {
  const turnsArg = argv.find((arg) => arg.startsWith("--turns="));
  if (!turnsArg) return 3;
  const parsed = Number(turnsArg.slice("--turns=".length));
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("[story-runtime] --turns must be a positive integer");
  }
  return parsed;
}

export function readOutputDirArg(argv: string[]): string {
  const outputDirArg = argv.find((arg) => arg.startsWith("--output-dir="));
  if (!outputDirArg) {
    return path.join(process.cwd(), "runs");
  }
  const outputDir = outputDirArg.slice("--output-dir=".length).trim();
  if (!outputDir) {
    throw new Error("[story-runtime] --output-dir must not be empty");
  }
  return path.resolve(process.cwd(), outputDir);
}

export function buildRunId(startedAt: string, runIdSuffix = randomBytes(4).toString("hex")): string {
  return `story-${startedAt.replace(/[:.]/g, "-")}-${runIdSuffix}`;
}
