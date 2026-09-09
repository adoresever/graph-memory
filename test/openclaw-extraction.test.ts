import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import graphMemoryPlugin from "../index.ts";
import { GRAPH_EXTRACTION_TOOL_NAME } from "../src/extractor/contract.ts";
import { closeDb, getDb } from "../src/store/db.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for OpenClaw extraction");
}

describe("OpenClaw completed-turn extraction", () => {
  it("extracts one question/final-answer pair and binds both source rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-openclaw-turn-"));
    const dbPath = join(dir, "memory.db");
    const payload = {
      summary: "用户要求记住结果，最终回答给出了已验证结果。",
      outcome: "completed",
      triples: [{
        subject: "最终回答",
        predicate: "保留",
        object: "已验证结果",
      }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{
        type: "function",
        function: { name: GRAPH_EXTRACTION_TOOL_NAME, arguments: JSON.stringify(payload) },
      }] } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    let engine: any;
    const api: any = {
      pluginConfig: { dbPath, llm: { baseUrl: "http://127.0.0.1:8080/v1", model: "test" } },
      config: {},
      logger: { info() {}, warn() {}, error() {} },
      on() {},
      registerTool() {},
      registerContextEngine(_name: string, factory: () => any) { engine = factory(); },
    };
    graphMemoryPlugin.register(api);

    const messages = [
      { role: "user", content: [{ type: "text", text: "remember this result" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "private" }, { type: "text", text: "the final answer is retained" }] },
    ];
    await engine.ingest({ sessionId: "s1", message: messages[0] });
    await engine.ingest({ sessionId: "s1", message: messages[1] });
    await engine.afterTurn({ sessionId: "s1", messages, prePromptMessageCount: 0 });

    const db = getDb(dbPath);
    await waitFor(() => Number((db.prepare(
      "SELECT COUNT(*) AS count FROM gm_messages WHERE extraction_state='succeeded'",
    ).get() as any).count) === 2);
    expect((db.prepare("SELECT COUNT(*) AS count FROM gm_nodes").get() as any).count).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM gm_navigation_terms").get() as any).count).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS count FROM gm_navigation_triples").get() as any).count).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM gm_turn_memories").get() as any).count).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM gm_turn_memory_sources").get() as any).count).toBe(2);

    await engine.dispose();
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });
});
