import { getDb, closeDb } from "./src/store/db.js";
import { runMaintenance } from "./src/graph/maintenance.js";
import { DEFAULT_CONFIG } from "./src/types.js";
import { createCompleteFn } from "./src/engine/llm.js";
import { createEmbedFn } from "./src/engine/embed.js";
import { readFileSync } from "fs";

const envPath = `${process.env.HOME}/.hermes/graph-memory.env`;
const envText = readFileSync(envPath, "utf-8");
const getEnv = (key: string) => {
  const m = envText.match(new RegExp(`${key}=(.+)`));
  return m ? m[1].trim() : undefined;
};

const dbPath = `${process.env.HOME}/.hermes/graph-memory.db`;

const llm = createCompleteFn({
  apiKey: getEnv("GRAPH_MEMORY_LLM_API_KEY"),
  baseURL: getEnv("GRAPH_MEMORY_LLM_BASE_URL"),
  model: getEnv("GRAPH_MEMORY_LLM_MODEL"),
});

const embed = await createEmbedFn({
  apiKey: getEnv("GRAPH_MEMORY_EMBED_API_KEY"),
  baseURL: getEnv("GRAPH_MEMORY_EMBED_BASE_URL"),
  model: getEnv("GRAPH_MEMORY_EMBED_MODEL"),
});

const cfg = { ...DEFAULT_CONFIG, dbPath };
const db = getDb(dbPath);

console.log("Starting direct maintenance...");
const start = Date.now();
const result = await runMaintenance(db, cfg, llm, embed || undefined);
console.log(`Done in ${Date.now() - start}ms`);
console.log(JSON.stringify(result, null, 2));
closeDb();
