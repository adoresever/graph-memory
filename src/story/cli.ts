import { closeDb, getDb } from "../store/db.ts";
import { loadStoryConfig } from "./config.ts";
import {
  createStoryModelClient,
  type ChapterPacket,
  type ChapterSelection,
  type FactionDecisionInput,
  type NarrativeDirectorInput,
  type StoryAction,
  type StoryClaim,
  type TurnSummaryInput,
} from "./runtime/model-client.ts";
import { runStoryLoop } from "./runtime/run-loop.ts";

export async function runStoryCli(argv: string[] = process.argv.slice(2)) {
  const useStubModel = argv.includes("--stub-model");
  const cfg = loadStoryConfig({ allowMissingLlmEnv: useStubModel });
  const turns = readTurnsArg(argv);

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
    const model = useStubModel ? createStubStoryModelClient() : createStoryModelClient(cfg.llm);
    const result = await runStoryLoop(db, { turns, model });
    console.log(`turns=${result.worldLogs.length}`);
    console.log(`chapters=${result.chapters.length}`);
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

function readTurnsArg(argv: string[]): number {
  const turnsArg = argv.find((arg) => arg.startsWith("--turns="));
  if (!turnsArg) return 3;
  const parsed = Number(turnsArg.slice("--turns=".length));
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("[story-runtime] --turns must be a positive integer");
  }
  return parsed;
}

function createStubStoryModelClient() {
  return {
    rerankActorActions: async (actions: StoryAction[]) => actions,
    rerankFactionActions: async (actions: StoryAction[], _context: FactionDecisionInput) => actions,
    rerankChapterFocus: async (candidates: ChapterSelection[], _context: NarrativeDirectorInput) => candidates,
    generateChapter: async (packet: ChapterPacket) =>
      `Stub chapter turn ${packet.turnNumber} focus ${packet.focus}. ${packet.summary ?? ""}`.trim(),
    summarizeTurn: async (input: TurnSummaryInput) =>
      `Stub turn ${input.turnNumber}: ${input.highlights.join("; ") || "no-highlights"}`,
    extractClaims: async (_prose: string): Promise<StoryClaim[]> => [],
  };
}
