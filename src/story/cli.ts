import { loadStoryConfig } from "./config.ts";
import { createStoryModelClient } from "./runtime/model-client.ts";

export async function runStoryCli(argv: string[] = process.argv.slice(2)) {
  const cfg = loadStoryConfig();
  const model = createStoryModelClient(cfg.llm);
  console.log("Story runtime configuration loaded:");
  console.log(`  mode=${cfg.llm.mode} model=${cfg.llm.model}`);
  if (cfg.resetOnStart) {
    console.log("  resetOnStart=true (runtime state will be cleared)");
  }
  console.log(`  dbPath=${cfg.dbPath}`);
  console.log("Model client initialized with baseURL:", cfg.llm.baseURL || "(not set)");
  console.log("Arguments:", argv.join(" "));
  return model;
}

if (import.meta.main) {
  runStoryCli().catch((err) => {
    console.error("Story CLI failed:", err);
    process.exit(1);
  });
}
