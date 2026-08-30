import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply, eventMessage } from "../dsh.ts";
import { DatabaseSync } from "../src/store/sqlite.ts";

function user(seq: number) {
  return {
    type: "user/message",
    seq,
    data: { id: `u${seq}`, role: "user", source: { kind: "user" }, content: [] },
  };
}

describe("native DSH context takeover", () => {
  it("keeps immutable source events but does not duplicate derived replacements", () => {
    expect(eventMessage({
      type: "assistant/message",
      surfaceOp: "append",
      data: { message: { content: [{ type: "text", text: "original" }] } },
    })).toEqual({
      role: "assistant",
      message: { content: [{ type: "text", text: "original" }] },
    });
    expect(eventMessage({
      type: "assistant/message",
      surfaceOp: { op: "replace", start: 1, end: 3 },
      sourceEventSeqs: [1, 2, 3],
      data: { message: { content: [{ type: "text", text: "derived" }] } },
    })).toBeUndefined();
  });

  it("uses the agent-scoped public compaction service and retains configurable turns", async () => {
    const listeners = new Map<string, Array<(...args: any[]) => any>>();
    const cleanups: Array<() => void | Promise<void>> = [];
    let compactionService: any;
    const context: any = {
      logger: { info() {}, warn() {}, error() {} },
      llm: { async *stream() {} },
      tools: { register() { return () => {}; } },
      credentials: { async resolve() { return undefined; } },
      agentPresets: {
        serviceFor(_agent: any, key: string) {
          expect(key).toBe("compaction");
          return compactionService;
        },
      },
      on(name: string, listener: (...args: any[]) => any, options?: Record<string, unknown>) {
        const current = listeners.get(name) ?? [];
        if (options?.prepend) current.unshift(listener);
        else current.push(listener);
        listeners.set(name, current);
        return () => {};
      },
      effect(register: () => () => void | Promise<void>) {
        cleanups.push(register());
        return () => {};
      },
    };
    apply(context, {
      dbPath: ":memory:",
      extractionEnabled: false,
      recallEnabled: false,
      freshTurnCount: 2,
    });

    const events: any[] = [];
    const surface: number[] = [];
    const agentListeners = new Map<string, Array<(...args: any[]) => any>>();
    for (let turn = 1; turn <= 3; turn += 1) {
      const userSeq = events.length;
      events.push(user(userSeq));
      surface.push(userSeq);
      const assistantSeq = events.length;
      events.push({ type: "assistant/message", seq: assistantSeq, data: {} });
      surface.push(assistantSeq);
    }
    const calls: any[][] = [];
    const agent = {
      session: { events, surface: { nodes: surface } },
      ctx: {
        on(name: string, listener: (...args: any[]) => any, options?: Record<string, unknown>) {
          const current = agentListeners.get(name) ?? [];
          if (options?.prepend) current.unshift(listener);
          else current.push(listener);
          agentListeners.set(name, current);
          return () => {};
        },
      },
    };
    compactionService = {
      async compactRegion(...args: any[]) {
        calls.push(args);
        return { shadowedSeqs: [0, 1] };
      },
    };
    listeners.get("agent/created")![0]({ agent });
    const next = async () => "continued";
    const result = await agentListeners.get("agent/pre-step")![0]({
      agent,
      signal: new AbortController().signal,
    }, next);

    expect(result).toBe("continued");
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(0);
    expect(calls[0][1]).toBe(1);
    expect(calls[0][2]).toBe(agent);
    await Promise.all(cleanups.map(cleanup => cleanup()));
  });

  it("keeps a 30-turn model surface bounded instead of growing linearly", async () => {
    const listeners = new Map<string, Array<(...args: any[]) => any>>();
    const cleanups: Array<() => void | Promise<void>> = [];
    let compactionService: any;
    const context: any = {
      logger: { info() {}, warn() {}, error() {} },
      llm: { async *stream() {} },
      tools: { register() { return () => {}; } },
      credentials: { async resolve() { return undefined; } },
      agentPresets: {
        serviceFor(_agent: any, key: string) {
          expect(key).toBe("compaction");
          return compactionService;
        },
      },
      on(name: string, listener: (...args: any[]) => any, options?: Record<string, unknown>) {
        const current = listeners.get(name) ?? [];
        if (options?.prepend) current.unshift(listener);
        else current.push(listener);
        listeners.set(name, current);
        return () => {};
      },
      effect(register: () => () => void | Promise<void>) {
        cleanups.push(register());
        return () => {};
      },
    };
    apply(context, {
      dbPath: ":memory:",
      extractionEnabled: false,
      recallEnabled: false,
      freshTurnCount: 5,
    });

    const events: any[] = [];
    const surface = { nodes: [] as number[] };
    const agentListeners = new Map<string, Array<(...args: any[]) => any>>();
    let compactions = 0;
    const agent: any = {
      id: "long-dialog",
      session: { events, surface },
      ctx: {
        on(name: string, listener: (...args: any[]) => any, options?: Record<string, unknown>) {
          const current = agentListeners.get(name) ?? [];
          if (options?.prepend) current.unshift(listener);
          else current.push(listener);
          agentListeners.set(name, current);
          return () => {};
        },
      },
    };
    compactionService = {
      async compactRegion(start: number, end: number) {
        const startPosition = surface.nodes.indexOf(start);
        const endPosition = surface.nodes.indexOf(end);
        const shadowedSeqs = surface.nodes.slice(startPosition, endPosition + 1);
        const replacementSeq = events.length;
        events.push({
          type: "user/message",
          seq: replacementSeq,
          surfaceOp: { op: "replace", start, end },
          sourceEventSeqs: shadowedSeqs,
          data: {
            source: { kind: "plugin", plugin: "compaction-basic" },
            content: [{ type: "text", text: `checkpoint-${compactions}`.padEnd(600, ".") }],
          },
        });
        surface.nodes.splice(startPosition, shadowedSeqs.length, replacementSeq);
        compactions += 1;
        return { shadowedSeqs };
      },
    };
    listeners.get("agent/created")![0]({ agent });

    const payload = "x".repeat(1_000);
    for (let turn = 0; turn < 30; turn += 1) {
      const claimed = {
        source: { kind: "user" },
        content: [{ type: "text", text: `user-${turn}-${payload}` }],
      };
      // Real DSH order: pre-step sees claimed inbox messages before those
      // messages are appended to the durable/model surface.
      await agentListeners.get("agent/pre-step")![0]({
        agent,
        messages: [claimed],
        signal: new AbortController().signal,
      }, async () => undefined);
      const userSeq = events.length;
      events.push({
        type: "user/message",
        seq: userSeq,
        surfaceOp: "append",
        data: claimed,
      });
      surface.nodes.push(userSeq);
      const assistantSeq = events.length;
      events.push({
        type: "assistant/message",
        seq: assistantSeq,
        surfaceOp: "append",
        data: {
          message: { content: [{ type: "text", text: `assistant-${turn}-${payload}` }] },
        },
      });
      surface.nodes.push(assistantSeq);
    }

    const realUsers = surface.nodes.filter(seq => (
      events[seq]?.type === "user/message" && events[seq]?.data?.source?.kind === "user"
    ));
    const surfaceChars = surface.nodes.reduce((total, seq) => {
      const event = events[seq];
      const content = event?.type === "assistant/message"
        ? event.data?.message?.content
        : event?.data?.content;
      return total + (content?.[0]?.text?.length ?? 0);
    }, 0);
    const uncompressedChars = 30 * 2 * (payload.length + 20);

    expect(compactions).toBe(25);
    expect(realUsers).toHaveLength(5);
    expect(surface.nodes).toHaveLength(11);
    expect(surfaceChars).toBeLessThan(uncompressedChars * 0.2);
    await Promise.all(cleanups.map(cleanup => cleanup()));
  });
});

function userMsg(seq: number, text: string) {
  return {
    type: "user/message",
    seq,
    data: { id: `u${seq}`, role: "user", source: { kind: "user" }, content: [{ type: "text", text }] },
  };
}

const EMPTY_EXTRACTION = '{"nodes":[],"edges":[]}';

function adapterContext(llmStream: () => AsyncGenerator<any>) {
  const listeners = new Map<string, Array<(...args: any[]) => any>>();
  const cleanups: Array<() => void | Promise<void>> = [];
  const logs: string[] = [];
  const log = (level: string) => (...args: any[]) => logs.push(`${level}:${args.join(" ")}`);
  const context: any = {
    logger: { info: log("info"), warn: log("warn"), error: log("error") },
    llm: { stream: llmStream },
    tools: { register() { return () => {}; } },
    credentials: { async resolve() { return undefined; } },
    agentPresets: { serviceFor() { return undefined; } },
    on(name: string, listener: (...args: any[]) => any, options?: Record<string, unknown>) {
      const current = listeners.get(name) ?? [];
      if (options?.prepend) current.unshift(listener);
      else current.push(listener);
      listeners.set(name, current);
      return () => {};
    },
    effect(register: () => () => void | Promise<void>) {
      cleanups.push(register());
      return () => {};
    },
  };
  return { context, listeners, cleanups, logs };
}

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function countPending(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT COUNT(*) AS c FROM gm_messages WHERE extracted = 0").get() as any;
    return Number(row.c);
  } finally {
    db.close();
  }
}

describe("extraction drain resilience", () => {
  it("retries a transient LLM failure and then drains the backlog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-resilience-"));
    const dbPath = join(dir, "graph-memory.db");
    let calls = 0;
    const { context, listeners, cleanups, logs } = adapterContext(async function* () {
      calls += 1;
      if (calls === 1) throw new Error("transient provider hiccup");
      yield { type: "text-delta", text: EMPTY_EXTRACTION };
      yield { type: "finish", reason: { kind: "stop" } };
    });
    apply(context, {
      dbPath,
      extractionEnabled: true,
      recallEnabled: false,
      llmProvider: "test-provider",
      llmModel: "test-model",
      extractionRetryDelaysMs: [0, 0],
    });
    const agent = { id: "transient-test", session: { events: [userMsg(0, "alpha"), userMsg(1, "beta")] } };
    listeners.get("agent/session-start")![0]({ agent });

    await waitFor(() => logs.some(l => l.includes("DSH extracted")));
    expect(logs.some(l => l.includes("retry in 0s"))).toBe(true);
    expect(logs.some(l => l.includes("SKIP"))).toBe(false);
    expect(countPending(dbPath)).toBe(0);
    await Promise.all(cleanups.map(cleanup => cleanup()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("never deadlocks on a permanently failing batch (retry -> bisect -> skip)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-resilience-"));
    const dbPath = join(dir, "graph-memory.db");
    const { context, listeners, cleanups, logs } = adapterContext(async function* () {
      throw new Error("always failing provider");
    });
    apply(context, {
      dbPath,
      extractionEnabled: true,
      recallEnabled: false,
      llmProvider: "test-provider",
      llmModel: "test-model",
      extractionRetryDelaysMs: [0, 0],
    });
    const agent = {
      id: "poison-test",
      session: { events: [userMsg(0, "alpha"), userMsg(1, "beta"), userMsg(2, "gamma")] },
    };
    listeners.get("agent/session-start")![0]({ agent });

    // Three messages: batch(3) fails out -> bisect -> each singleton skips.
    await waitFor(() => logs.filter(l => l.includes("DSH extraction SKIP")).length >= 3);
    const skipLogs = logs.filter(l => l.includes("DSH extraction SKIP"));
    expect(skipLogs.length).toBe(3);
    expect(logs.some(l => l.includes("split 3 -> 2+1"))).toBe(true);
    // The drain still makes progress: every message is marked extracted.
    expect(countPending(dbPath)).toBe(0);
    await Promise.all(cleanups.map(cleanup => cleanup()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("caps each extraction batch by accumulated normalized length", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-resilience-"));
    const dbPath = join(dir, "graph-memory.db");
    const users: string[] = [];
    const { context, listeners, cleanups, logs } = adapterContext(async function* (opts: any) {
      users.push(opts.messages[0].content[0].text);
      yield { type: "text-delta", text: EMPTY_EXTRACTION };
      yield { type: "finish", reason: { kind: "stop" } };
    });
    apply(context, {
      dbPath,
      extractionEnabled: true,
      recallEnabled: false,
      llmProvider: "test-provider",
      llmModel: "test-model",
      extractionRetryDelaysMs: [0, 0],
    });
    // One 10K-char message (always fits alone) plus two short messages:
    // the long one must not drag the short ones into an oversized request.
    const long = "x".repeat(10_000);
    const agent = {
      id: "length-test",
      session: { events: [userMsg(0, long), userMsg(1, "short-a"), userMsg(2, "short-b")] },
    };
    listeners.get("agent/session-start")![0]({ agent });

    await waitFor(() => logs.filter(l => l.includes("DSH extracted")).length >= 2);
    expect(users.length).toBeGreaterThanOrEqual(2);
    for (const user of users) {
      // template (34) + names hint (<=3000) + msgs (<=8000) + JSON wrappers
      expect(user.length).toBeLessThan(12_000);
    }
    expect(countPending(dbPath)).toBe(0);
    await Promise.all(cleanups.map(cleanup => cleanup()));
    rmSync(dir, { recursive: true, force: true });
  });
});
