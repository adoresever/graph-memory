import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply } from "../dsh.ts";
import { GRAPH_EXTRACTION_TOOL_NAME } from "../src/extractor/contract.ts";
import { DatabaseSync } from "../src/store/sqlite.ts";

function user(seq: number) {
  return {
    type: "user/message",
    seq,
    data: { id: `u${seq}`, role: "user", source: { kind: "user" }, content: [] },
  };
}

describe("native DSH context takeover", () => {
  it("adds no assistant tool schema by default", async () => {
    const tools: string[] = [];
    const cleanups: Array<() => void | Promise<void>> = [];
    apply({
      logger: { info() {}, warn() {}, error() {} },
      llm: { async *stream() {} },
      tools: { register(definition: any) { tools.push(definition.name); return () => {}; } },
      credentials: { async resolve() { return undefined; } },
      on() { return () => {}; },
      effect(register: () => () => void | Promise<void>) { cleanups.push(register()); return () => {}; },
    } as any, { dbPath: ":memory:", extractionEnabled: false, recallEnabled: false });
    expect(tools).toEqual([]);
    await Promise.all(cleanups.map(cleanup => cleanup()));
  });

  it("fails closed on an ambiguous destructive retention policy", () => {
    expect(() => apply({} as any, {
      dbPath: ":memory:",
      messageRetention: { keep: "recent" },
    })).toThrow(/requires recentTurns or retentionDays/);
  });

  it("exposes the effective retention policy and bounded maintenance receipt", async () => {
    const tools = new Map<string, any>();
    const cleanups: Array<() => void | Promise<void>> = [];
    const context: any = {
      logger: { info() {}, warn() {}, error() {} },
      llm: { async *stream() {} },
      tools: {
        register(definition: any) {
          tools.set(definition.name, definition);
          return () => {};
        },
      },
      credentials: { async resolve() { return undefined; } },
      agentPresets: { serviceFor() { return undefined; } },
      on() { return () => {}; },
      effect(register: () => () => void | Promise<void>) {
        cleanups.push(register());
        return () => {};
      },
    };
    apply(context, {
      dbPath: ":memory:",
      extractionEnabled: false,
      recallEnabled: false,
      assistantTools: "all",
      messageRetention: {
        keep: "referenced",
        recentTurns: 5,
        batchSize: 25,
        dryRun: true,
      },
    });

    const status = await tools.get("gm_status").execute();
    expect(status).toContain("Message retention: keep=referenced");
    expect(status).toContain("recentTurns=5");
    expect(status).toContain("dryRun=true");

    const receipt = JSON.parse(await tools.get("gm_maintain").execute());
    expect(receipt.retention).toMatchObject({
      policy: "referenced",
      dryRun: true,
      selectedRows: 0,
      deletedRows: 0,
    });
    const stats = await tools.get("gm_stats").execute();
    expect(stats).toContain('"dryRuns":1');
    expect(stats).toContain("Last retention receipt:");
    await Promise.all(cleanups.map(cleanup => cleanup()));
  });

  it("takes over the DSH surface without calling a compaction model", async () => {
    const listeners = new Map<string, Array<(...args: any[]) => any>>();
    const cleanups: Array<() => void | Promise<void>> = [];
    const context: any = {
      logger: { info() {}, warn() {}, error() {} },
      llm: { async *stream() {} },
      tools: { register() { return () => {}; } },
      credentials: { async resolve() { return undefined; } },
      tokenMeter: {
        measure(session: any) {
          return { nodes: session.surface.nodes.map((seq: number) => ({ seq, heuristicTokens: 10 })) };
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
    const session: any = {
      id: "takeover-test",
      events,
      surface: { nodes: surface },
      append(type: string, data: any, options?: any) {
        const seq = events.length;
        const event = { type, seq, data, ...options };
        events.push(event);
        if (options?.surfaceOp?.op === "replace") {
          const start = surface.indexOf(options.surfaceOp.start);
          const end = surface.indexOf(options.surfaceOp.end);
          surface.splice(start, end - start + 1, seq);
        }
        return event;
      },
    };
    const agent = {
      id: "takeover-test",
      session,
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
    listeners.get("agent/created")![0]({ agent });
    const next = async () => "continued";
    const result = await agentListeners.get("agent/pre-step")![0]({
      agent,
      messages: [{ source: { kind: "user" } }],
      signal: new AbortController().signal,
    }, next);

    expect(result).toBe("continued");
    expect(events.at(-2)).toMatchObject({
      type: "compaction/prune",
      data: { shadowedSeqs: [0, 1], shadowedTokenCount: 20 },
    });
    expect(events.at(-1)).toMatchObject({
      type: "user/message",
      surfaceOp: { op: "replace", start: 0, end: 1 },
      data: { source: { kind: "plugin", plugin: "graph-memory" } },
    });
    expect(surface).toEqual([events.length - 1, 2, 3, 4, 5]);
    await Promise.all(cleanups.map(cleanup => cleanup()));
  });

  it("keeps a 30-turn model surface bounded instead of growing linearly", async () => {
    const listeners = new Map<string, Array<(...args: any[]) => any>>();
    const cleanups: Array<() => void | Promise<void>> = [];
    const context: any = {
      logger: { info() {}, warn() {}, error() {} },
      llm: { async *stream() {} },
      tools: { register() { return () => {}; } },
      credentials: { async resolve() { return undefined; } },
      tokenMeter: {
        measure(session: any) {
          return {
            nodes: session.surface.nodes.map((seq: number) => {
              const event = session.events[seq];
              const content = event?.type === "assistant/message"
                ? event.data?.message?.content
                : event?.data?.content;
              const chars = content?.[0]?.text?.length ?? 0;
              return { seq, heuristicTokens: Math.max(1, Math.ceil(chars / 4)) };
            }),
          };
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
    const session: any = {
      id: "long-dialog",
      events,
      surface,
      append(type: string, data: any, options?: any) {
        const seq = events.length;
        const event = { type, seq, data, ...options };
        events.push(event);
        if (options?.surfaceOp?.op === "replace") {
          const startPosition = surface.nodes.indexOf(options.surfaceOp.start);
          const endPosition = surface.nodes.indexOf(options.surfaceOp.end);
          surface.nodes.splice(startPosition, endPosition - startPosition + 1, seq);
          compactions += 1;
        }
        return event;
      },
    };
    const agent: any = {
      id: "long-dialog",
      session,
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

    expect(compactions).toBe(24);
    expect(realUsers).toHaveLength(6);
    expect(surface.nodes).toHaveLength(13);
    expect(surfaceChars).toBeLessThan(uncompressedChars * 0.22);
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

const EMPTY_EXTRACTION = '{"turn":{"summary":"question was answered","outcome":"informational","sourceTurns":[1]},"nodes":[],"edges":[],"invalidations":[]}';
const TURN_TWO_EMPTY_EXTRACTION = '{"turn":{"summary":"new question was answered","outcome":"informational","sourceTurns":[2]},"nodes":[],"edges":[],"invalidations":[]}';

function structuredExtraction(argumentsJson: string) {
  return {
    type: "block-end",
    block: {
      type: "tool-call",
      id: "extraction-call",
      name: GRAPH_EXTRACTION_TOOL_NAME,
      arguments: argumentsJson,
    },
  };
}

function adapterContext(llmStream: (options?: any) => AsyncGenerator<any>) {
  const listeners = new Map<string, Array<(...args: any[]) => any>>();
  const cleanups: Array<() => void | Promise<void>> = [];
  const tools = new Map<string, any>();
  const logs: string[] = [];
  const log = (level: string) => (...args: any[]) => logs.push(`${level}:${args.join(" ")}`);
  const context: any = {
    logger: { info: log("info"), warn: log("warn"), error: log("error") },
    llm: { stream: llmStream },
    tools: { register(definition: any) { tools.set(definition.name, definition); return () => {}; } },
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
  return { context, listeners, cleanups, logs, tools };
}

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function countState(dbPath: string, state: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT COUNT(*) AS c FROM gm_messages WHERE extraction_state = ?").get(state) as any;
    return Number(row.c);
  } finally {
    db.close();
  }
}

describe("DSH completed-turn memory extraction", () => {
  it("never imports an existing Session backlog automatically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-live-turn-only-"));
    const dbPath = join(dir, "graph-memory.db");
    const requests: any[] = [];
    const session: any = { id: "existing-session", events: [
      { type: "turn/start", seq: 0, data: { turn: 1 } },
      userMsg(1, "old question that predates plugin startup"),
      { type: "assistant/message", seq: 2, data: { turn: 1, message: { content: [{ type: "text", text: "old answer" }] } } },
      { type: "turn/end", seq: 3, data: { turn: 1, reason: { kind: "completed" } } },
    ] };
    const agentListeners = new Map<string, (...args: any[]) => any>();
    const agent: any = {
      id: session.id,
      session,
      ctx: {
        on(name: string, listener: (...args: any[]) => any) {
          agentListeners.set(name, listener);
          return () => {};
        },
      },
    };
    const { context, listeners, cleanups } = adapterContext(async function* (options: any) {
      requests.push(options);
      yield structuredExtraction(TURN_TWO_EMPTY_EXTRACTION);
      yield { type: "finish", reason: { kind: "tool-calls" } };
    });
    context.agents = {
      list: () => [agent],
      get: () => agent,
    };
    apply(context, {
      dbPath,
      extractionEnabled: true,
      recallEnabled: false,
      llmProvider: "test-provider",
      llmModel: "test-model",
    });
    const legacy = new DatabaseSync(dbPath);
    try {
      const insert = legacy.prepare(`
        INSERT INTO gm_messages
          (id, session_id, turn_index, role, content, created_at)
        VALUES (?, 'dsh:existing-session', 1, ?, ?, ?)
      `);
      insert.run("legacy-user", "user", JSON.stringify("legacy queued question"), Date.now());
      insert.run("legacy-assistant", "assistant", JSON.stringify("legacy queued answer"), Date.now());
    } finally {
      legacy.close();
    }

    for (const listener of listeners.get("agent/session-start") ?? []) {
      await listener({ agent });
    }
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(requests).toHaveLength(0);
    const before = new DatabaseSync(dbPath);
    try {
      expect((before.prepare("SELECT COUNT(*) AS c FROM gm_messages").get() as any).c).toBe(2);
      expect((before.prepare("SELECT COUNT(*) AS c FROM gm_messages WHERE extraction_state='pending'").get() as any).c).toBe(2);
    } finally {
      before.close();
    }

    session.events.push(
      { type: "turn/start", seq: 4, data: { turn: 2 } },
      userMsg(5, "new question after plugin startup"),
      { type: "assistant/message", seq: 6, data: { turn: 2, message: { content: [{ type: "text", text: "new answer" }] } } },
      { type: "turn/end", seq: 7, data: { turn: 2, reason: { kind: "completed" } } },
    );
    await listeners.get("session/event")![0](session, session.events[7]);
    await waitFor(() => countState(dbPath, "succeeded") === 2);
    expect(countState(dbPath, "pending")).toBe(2);
    expect(requests).toHaveLength(1);
    const prompt = requests[0].messages[0].content[0].text;
    expect(prompt).toContain("new question after plugin startup");
    expect(prompt).not.toContain("old question that predates plugin startup");

    await Promise.all(cleanups.map(cleanup => cleanup()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses one turn/end worker call with only the question and final answer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-turn-memory-"));
    const dbPath = join(dir, "graph-memory.db");
    const requests: any[] = [];
    const { context, listeners, cleanups } = adapterContext(async function* (options: any) {
      requests.push(options);
      yield structuredExtraction(EMPTY_EXTRACTION);
      yield { type: "finish", reason: { kind: "tool-calls" } };
    });
    apply(context, {
      dbPath,
      extractionEnabled: true,
      recallEnabled: false,
      llmProvider: "test-provider",
      llmModel: "test-model",
    });
    expect(listeners.has("agent/turn-stopping")).toBe(false);

    const session: any = { id: "semantic-turn", events: [
      { type: "turn/start", seq: 0, data: { turn: 1 } },
      userMsg(1, "What should we remember?"),
      { type: "assistant/message", seq: 2, data: { turn: 1, message: { content: [
        { type: "reasoning", text: "private chain of thought" },
        { type: "tool-call", name: "read", arguments: { path: "secret" } },
      ] } } },
      { type: "tool/result", seq: 3, data: { turn: 1, message: { content: [{ type: "text", text: "large tool output" }] } } },
      { type: "assistant/message", seq: 4, data: { turn: 1, message: { content: [
        { type: "reasoning", text: "final hidden reasoning" },
        { type: "text", text: "Remember the verified final result." },
      ] } } },
      { type: "turn/end", seq: 5, data: { turn: 1, reason: { kind: "completed" } } },
    ] };
    await listeners.get("session/event")![0](session, session.events[5]);
    await waitFor(() => countState(dbPath, "succeeded") === 2);

    expect(requests).toHaveLength(1);
    expect(requests[0].maxTokens).toBeUndefined();
    expect(requests[0].reasoningEffort).toBe("off");
    expect(requests[0].tools).toHaveLength(1);
    expect(requests[0].tools[0].name).toBe(GRAPH_EXTRACTION_TOOL_NAME);
    expect(requests[0].tools[0].parameters.required).toEqual(["turn", "nodes", "edges", "invalidations"]);
    const prompt = requests[0].messages[0].content[0].text;
    expect(prompt).toContain("What should we remember?");
    expect(prompt).toContain("Remember the verified final result.");
    expect(prompt).not.toContain("private chain of thought");
    expect(prompt).not.toContain("large tool output");
    expect(prompt).not.toContain("final hidden reasoning");
    const stored = new DatabaseSync(dbPath);
    try {
      expect((stored.prepare("SELECT COUNT(*) AS c FROM gm_turn_memories").get() as any).c).toBe(1);
      expect((stored.prepare("SELECT COUNT(*) AS c FROM gm_turn_memory_sources").get() as any).c).toBe(2);
    } finally {
      stored.close();
    }

    await Promise.all(cleanups.map(cleanup => cleanup()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("never blocks turn/end and recovers a shutdown-deferred extraction on startup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-background-extraction-"));
    const dbPath = join(dir, "graph-memory.db");
    let markExtractionStarted!: () => void;
    const extractionStarted = new Promise<void>((resolve) => {
      markExtractionStarted = resolve;
    });
    const { context, listeners, cleanups } = adapterContext(async function* (options: any) {
      markExtractionStarted();
      await new Promise<void>((resolve) => {
        options.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw options.signal.reason ?? new Error("extraction aborted");
    });
    apply(context, {
      dbPath,
      extractionEnabled: true,
      recallEnabled: false,
      llmProvider: "rate-limited-provider",
      llmModel: "rate-limited-model",
    });

    const session: any = { id: "stalled-extraction", events: [
      { type: "turn/start", seq: 0, data: { turn: 1 } },
      userMsg(1, "This turn must still close."),
      { type: "assistant/message", seq: 2, data: { turn: 1, message: { content: [
        { type: "text", text: "The foreground answer is complete." },
      ] } } },
      { type: "turn/end", seq: 3, data: { turn: 1, reason: { kind: "completed" } } },
    ] };

    const returned = listeners.get("session/event")![0](session, session.events[3]);
    expect(returned).toBeUndefined();
    expect(session.events.at(-1)?.type).toBe("turn/end");
    await extractionStarted;
    expect(countState(dbPath, "pending")).toBe(2);

    await Promise.all(cleanups.map(cleanup => cleanup()));
    expect(countState(dbPath, "pending")).toBe(2);
    expect(countState(dbPath, "quarantined")).toBe(0);

    const recoveredRequests: any[] = [];
    const recovered = adapterContext(async function* (options: any) {
      recoveredRequests.push(options);
      yield structuredExtraction(EMPTY_EXTRACTION);
      yield { type: "finish", reason: { kind: "tool-calls" } };
    });
    apply(recovered.context, {
      dbPath,
      extractionEnabled: true,
      recallEnabled: false,
      llmProvider: "recovery-provider",
      llmModel: "recovery-model",
    });
    await waitFor(() => countState(dbPath, "succeeded") === 2);
    expect(recoveredRequests).toHaveLength(1);
    expect(recoveredRequests[0].messages[0].content[0].text).toContain("This turn must still close.");
    await Promise.all(recovered.cleanups.map(cleanup => cleanup()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("prefers the configured extraction route over the foreground Agent route", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-extraction-route-"));
    const dbPath = join(dir, "graph-memory.db");
    const requests: any[] = [];
    const { context, listeners, cleanups } = adapterContext(async function* (options: any) {
      requests.push(options);
      yield structuredExtraction(EMPTY_EXTRACTION);
      yield { type: "finish", reason: { kind: "tool-calls" } };
    });
    apply(context, {
      dbPath,
      extractionEnabled: true,
      recallEnabled: false,
      llmProvider: "memory-provider",
      llmModel: "memory-model",
      llmReasoningEffort: "off",
      llmMaxTokens: 900,
    });
    const session: any = { id: "dedicated-route", events: [
      { type: "turn/start", seq: 0, data: { turn: 1 } },
      { type: "request/header", seq: 1, data: { header: { config: { provider: "agent-provider", model: "agent-model" } } } },
      userMsg(2, "question"),
      { type: "assistant/message", seq: 3, data: { turn: 1, message: { content: [{ type: "text", text: "answer" }] } } },
      { type: "turn/end", seq: 4, data: { turn: 1, reason: { kind: "completed" } } },
    ] };
    await listeners.get("session/event")![0](session, session.events[1]);
    await listeners.get("session/event")![0](session, session.events[4]);
    await waitFor(() => countState(dbPath, "succeeded") === 2);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      provider: "memory-provider",
      model: "memory-model",
      reasoningEffort: "off",
      maxTokens: 900,
    });
    expect(requests[0].messages[0].content[0].text).not.toContain("<Output Limits>");

    await Promise.all(cleanups.map(cleanup => cleanup()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes prior graph knowledge into the next turn and applies a temporal correction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-temporal-revision-"));
    const dbPath = join(dir, "graph-memory.db");
    const requests: any[] = [];
    const outputs = [
      JSON.stringify({
        turn: { summary: "项目端口确认为 8080。", outcome: "informational", sourceTurns: [1] },
        nodes: [{
          type: "EVENT", name: "project-port", description: "项目当前端口",
          content: "端口是 8080", operation: "create",
          temporal: { eventTime: "第一轮", state: "current" }, sourceTurns: [1],
        }],
        edges: [], invalidations: [],
      }),
      JSON.stringify({
        turn: { summary: "项目端口从 8080 修订为 9090。", outcome: "completed", sourceTurns: [2] },
        nodes: [{
          type: "EVENT", name: "project-port", description: "项目当前端口",
          content: "端口是 9090", operation: "revise",
          temporal: { eventTime: "第二轮", state: "current" }, sourceTurns: [2],
        }],
        edges: [], invalidations: [],
      }),
    ];
    const { context, listeners, cleanups } = adapterContext(async function* (options: any) {
      requests.push(options);
      yield structuredExtraction(outputs[requests.length - 1]);
      yield { type: "finish", reason: { kind: "tool-calls" } };
    });
    apply(context, {
      dbPath,
      extractionEnabled: true,
      recallEnabled: false,
      llmProvider: "test-provider",
      llmModel: "test-model",
    });

    const session: any = { id: "revision-session", events: [
      { type: "turn/start", seq: 0, data: { turn: 1 } },
      userMsg(1, "项目端口是多少？"),
      { type: "assistant/message", seq: 2, data: { turn: 1, message: { content: [{ type: "text", text: "确认是 8080。" }] } } },
      { type: "turn/end", seq: 3, data: { turn: 1, reason: { kind: "completed" } } },
    ] };
    await listeners.get("session/event")![0](session, session.events[3]);
    await waitFor(() => countState(dbPath, "succeeded") === 2);

    session.events.push(
      { type: "turn/start", seq: 4, data: { turn: 2 } },
      userMsg(5, "上一轮端口说错了，正确的是 9090。"),
      { type: "assistant/message", seq: 6, data: { turn: 2, message: { content: [{ type: "text", text: "已纠正为 9090。" }] } } },
      { type: "turn/end", seq: 7, data: { turn: 2, reason: { kind: "completed" } } },
    );
    await listeners.get("session/event")![0](session, session.events[7]);
    await waitFor(() => countState(dbPath, "succeeded") === 4);

    expect(requests).toHaveLength(2);
    const secondPrompt = requests[1].messages[0].content[0].text;
    expect(secondPrompt).toContain('"name":"project-port"');
    expect(secondPrompt).toContain("端口是 8080");
    const inspect = new DatabaseSync(dbPath);
    try {
      const node = inspect.prepare(
        "SELECT content, temporal_json, validated_count FROM gm_nodes WHERE name='project-port'",
      ).get() as any;
      expect(node.content).toBe("端口是 9090");
      expect(JSON.parse(node.temporal_json)).toEqual({ eventTime: "第二轮", state: "current" });
      expect(node.validated_count).toBe(1);
      const activeSources = inspect.prepare(`
        SELECT s.turn_index FROM gm_node_sources s
        JOIN gm_nodes n ON n.id=s.node_id
        WHERE n.name='project-port' ORDER BY s.turn_index
      `).all() as Array<{ turn_index: number }>;
      expect(activeSources.map(source => source.turn_index)).toEqual([2, 2]);
      const revision = inspect.prepare(`
        SELECT previous_content, previous_source_refs
        FROM gm_node_revisions r JOIN gm_nodes n ON n.id=r.node_id
        WHERE n.name='project-port'
      `).get() as any;
      expect(revision.previous_content).toBe("端口是 8080");
      expect(JSON.parse(revision.previous_source_refs)).toHaveLength(2);
    } finally {
      inspect.close();
    }

    await Promise.all(cleanups.map(cleanup => cleanup()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("never parses a max-tokens response and never retries it automatically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-max-tokens-"));
    const dbPath = join(dir, "graph-memory.db");
    let calls = 0;
    const { context, listeners, cleanups } = adapterContext(async function* () {
      calls += 1;
      yield { type: "text-delta", text: '{"nodes":[' };
      yield { type: "finish", reason: { kind: "max-tokens" } };
    });
    apply(context, {
      dbPath,
      extractionEnabled: true,
      recallEnabled: false,
      llmProvider: "test-provider",
      llmModel: "test-model",
    });
    const session: any = { id: "truncated-turn", events: [
      { type: "turn/start", seq: 0, data: { turn: 1 } },
      userMsg(1, "question"),
      { type: "assistant/message", seq: 2, data: { turn: 1, message: { content: [{ type: "text", text: "answer" }] } } },
      { type: "turn/end", seq: 3, data: { turn: 1, reason: { kind: "completed" } } },
    ] };
    await listeners.get("session/event")![0](session, session.events[3]);
    await waitFor(() => countState(dbPath, "quarantined") === 2);
    expect(calls).toBe(1);

    await Promise.all(cleanups.map(cleanup => cleanup()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails closed when the model returns text instead of the extraction contract", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-text-extraction-"));
    const dbPath = join(dir, "graph-memory.db");
    const { context, listeners, cleanups } = adapterContext(async function* () {
      yield { type: "text-delta", text: EMPTY_EXTRACTION };
      yield { type: "finish", reason: { kind: "stop" } };
    });
    apply(context, {
      dbPath,
      extractionEnabled: true,
      recallEnabled: false,
      llmProvider: "test-provider",
      llmModel: "test-model",
    });
    const session: any = { id: "text-contract-turn", events: [
      { type: "turn/start", seq: 0, data: { turn: 1 } },
      userMsg(1, "question"),
      { type: "assistant/message", seq: 2, data: { turn: 1, message: { content: [{ type: "text", text: "answer" }] } } },
      { type: "turn/end", seq: 3, data: { turn: 1, reason: { kind: "completed" } } },
    ] };
    await listeners.get("session/event")![0](session, session.events[3]);
    await waitFor(() => countState(dbPath, "quarantined") === 2);

    await Promise.all(cleanups.map(cleanup => cleanup()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses the sole structured payload and ignores non-authoritative preamble text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-structured-preamble-"));
    const dbPath = join(dir, "graph-memory.db");
    const { context, listeners, cleanups, logs } = adapterContext(async function* () {
      yield { type: "text-delta", text: "Submitting the validated graph." };
      yield structuredExtraction(EMPTY_EXTRACTION);
      yield { type: "finish", reason: { kind: "tool-calls" } };
    });
    apply(context, {
      dbPath,
      extractionEnabled: true,
      recallEnabled: false,
      llmProvider: "test-provider",
      llmModel: "test-model",
    });
    const session: any = { id: "structured-preamble-turn", events: [
      { type: "turn/start", seq: 0, data: { turn: 1 } },
      userMsg(1, "question"),
      { type: "assistant/message", seq: 2, data: { turn: 1, message: { content: [{ type: "text", text: "answer" }] } } },
      { type: "turn/end", seq: 3, data: { turn: 1, reason: { kind: "completed" } } },
    ] };
    await listeners.get("session/event")![0](session, session.events[3]);
    await waitFor(() => countState(dbPath, "succeeded") === 2);
    expect(logs.some(message => message.includes("non-authoritative text"))).toBe(true);

    await Promise.all(cleanups.map(cleanup => cleanup()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails closed when a structured tool-call omits a required field", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-incomplete-contract-"));
    const dbPath = join(dir, "graph-memory.db");
    const { context, listeners, cleanups } = adapterContext(async function* () {
      yield structuredExtraction('{"nodes":[],"edges":[]}');
      yield { type: "finish", reason: { kind: "tool-calls" } };
    });
    apply(context, {
      dbPath,
      extractionEnabled: true,
      recallEnabled: false,
      llmProvider: "test-provider",
      llmModel: "test-model",
    });
    const session: any = { id: "incomplete-contract-turn", events: [
      { type: "turn/start", seq: 0, data: { turn: 1 } },
      userMsg(1, "question"),
      { type: "assistant/message", seq: 2, data: { turn: 1, message: { content: [{ type: "text", text: "answer" }] } } },
      { type: "turn/end", seq: 3, data: { turn: 1, reason: { kind: "completed" } } },
    ] };
    await listeners.get("session/event")![0](session, session.events[3]);
    await waitFor(() => countState(dbPath, "quarantined") === 2);

    await Promise.all(cleanups.map(cleanup => cleanup()));
    rmSync(dir, { recursive: true, force: true });
  });
});
