/**
 * 并发批量提取未提取消息（小 batch + 高并发）。
 *   BATCH=6 消息/call（推理快，少超时）
 *   CONCURRENCY=20 路 worker（deepseek 支持高并发）
 * worker-pool：一个 batch 完成立即取下一个，稳态并发。
 *
 * 运行（在旧插件目录）：
 *   cd ~/.openclaw/extensions/graph-memory && npx tsx extract_unextracted.ts
 * 幂等：每批完成后 markExtracted，崩溃可重跑续。
 */
import { DatabaseSync } from "@photostructure/sqlite";
import { createCompleteFn } from "./src/engine/llm.ts";
import { Extractor } from "./src/extractor/extract.ts";
import {
  getUnextracted, markExtracted, getBySession,
  upsertNode, upsertEdge, findByName,
} from "./src/store/store.ts";
import fs from "node:fs";

const BACKUP = process.env.HOME + "/graph-memory.db.bak-20260731-204444";
const SKIP_PREFIX = "memory-reflection-cli";
const BATCH = 6;
const CONCURRENCY = 20;
const CALL_TIMEOUT_MS = 90_000;

const oc = JSON.parse(fs.readFileSync(process.env.HOME + "/.openclaw/openclaw.json", "utf8"));
const llmCfg = oc.plugins.entries["graph-memory"].config.llm;

const db = new DatabaseSync(BACKUP);
db.exec("PRAGMA journal_mode=WAL");

const llm = createCompleteFn("openai", llmCfg.model, llmCfg);
const extractor = new Extractor({ llm: llmCfg } as any, llm);

const sessions = db.prepare(
  "SELECT DISTINCT session_id FROM gm_messages WHERE extracted=0 AND session_id NOT LIKE ? ORDER BY session_id",
).all(`${SKIP_PREFIX}%`).map((r: any) => r.session_id);

// 预取所有 batch（不 markExtracted，崩溃可重跑）
interface Batch { sid: string; msgs: any[]; maxTurn: number; }
const batches: Batch[] = [];
for (const sid of sessions) {
  const all = getUnextracted(db, sid, 1_000_000);
  for (let i = 0; i < all.length; i += BATCH) {
    const chunk = all.slice(i, i + BATCH);
    batches.push({ sid, msgs: chunk, maxTurn: Math.max(...chunk.map((m: any) => m.turn_index)) });
  }
}
console.log(`[extract] ${batches.length} batches (BATCH=${BATCH} concurrency=${CONCURRENCY} model=${llmCfg.model})`);

let done = 0, totalNodes = 0, totalEdges = 0, failed = 0;
const t0 = Date.now();

async function processBatch(b: Batch): Promise<{ n: number; e: number; err?: string }> {
  const existing = getBySession(db, b.sid).map((n: any) => n.name);
  try {
    const result = await Promise.race([
      extractor.extract({ messages: b.msgs, existingNames: existing }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("call timeout")), CALL_TIMEOUT_MS)),
    ]);
    const nameToId = new Map<string, string>();
    for (const nc of result.nodes) {
      const { node } = upsertNode(db, {
        type: nc.type, name: nc.name, description: nc.description, content: nc.content,
      }, b.sid);
      nameToId.set(node.name, node.id);
    }
    for (const ec of result.edges) {
      const fromNode = findByName(db, ec.from);
      const toNode = findByName(db, ec.to);
      const fromId = nameToId.get(ec.from) ?? fromNode?.id;
      const toId = nameToId.get(ec.to) ?? toNode?.id;
      if (fromId && toId) {
        upsertEdge(db, {
          fromId, toId, type: ec.type, instruction: ec.instruction,
          condition: ec.condition, sessionId: b.sid,
        });
      }
    }
    markExtracted(db, b.sid, b.maxTurn);
    return { n: result.nodes.length, e: result.edges.length };
  } catch (err) {
    markExtracted(db, b.sid, b.maxTurn); // claim，避免死循环
    return { n: 0, e: 0, err: String(err).slice(0, 80) };
  }
}

// worker pool：稳态并发，一个完成立即取下一个
let nextIdx = 0;
async function worker(): Promise<void> {
  while (nextIdx < batches.length) {
    const my = nextIdx++;
    const r = await processBatch(batches[my]);
    done++;
    totalNodes += r.n;
    totalEdges += r.e;
    if (r.err) failed++;
    if (done % 20 === 0 || done === batches.length) {
      const el = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`[extract] ${done}/${batches.length} | nodes=${totalNodes} edges=${totalEdges} failed=${failed} | ${el}s`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

const el = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\n[extract] COMPLETE: ${done} batches in ${el}s | +${totalNodes} nodes +${totalEdges} edges (${failed} failed)`);
console.log(`[extract] now re-run: python3 migrate/migrate.py ${BACKUP} bolt://localhost:7687 neo4j graphmemory --reset`);
db.close();
