import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply } from "../dsh.ts";
import { GRAPH_EXTRACTION_TOOL_NAME } from "../src/extractor/contract.ts";
import { detectNavigationCommunities } from "../src/graph/community.ts";
import { DatabaseSync } from "../src/store/sqlite.ts";
import {
  replaceNavigationTriples,
  saveMessageOnce,
  upsertTurnMemory,
} from "../src/store/store.ts";

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
          const start = surface.indexOf(options.surfaceOp.startSeq);
          const end = surface.indexOf(options.surfaceOp.endSeq);
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
      surfaceOp: { op: "replace", startSeq: 0, endSeq: 1 },
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
          const startPosition = surface.nodes.indexOf(options.surfaceOp.startSeq);
          const endPosition = surface.nodes.indexOf(options.surfaceOp.endSeq);
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

  it("injects SPO/PPR-selected cross-session source Q/A before the current user", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-dsh-navigation-recall-"));
    const dbPath = join(dir, "graph-memory.db");
    const listeners = new Map<string, Array<(...args: any[]) => any>>();
    const cleanups: Array<() => void | Promise<void>> = [];
    const context: any = {
      logger: { info() {}, warn() {}, error() {} },
      llm: { async *stream() {} },
      tools: { register() { return () => {}; } },
      credentials: { async resolve() { return undefined; } },
      tokenMeter: { measure() { return { nodes: [] }; } },
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
      dbPath,
      extractionEnabled: false,
      recallEnabled: true,
      contextCompactionEnabled: false,
      recallMaxNodes: 2,
    });

    const stored = new DatabaseSync(dbPath);
    const addMemory = (
      turn: number,
      summary: string,
      question: string,
      answer: string,
      triple: { subject: string; predicate: string; object: string },
    ) => {
      const userId = `dsh:history:user:${turn}`;
      const assistantId = `dsh:history:assistant:${turn}`;
      saveMessageOnce(stored, userId, "dsh:history", turn, "user", question);
      saveMessageOnce(stored, assistantId, "dsh:history", turn, "assistant", answer);
      const memory = upsertTurnMemory(stored, {
        sessionId: "dsh:history",
        summary,
        outcome: "completed",
        sources: [
          { messageId: userId, turnIndex: turn },
          { messageId: assistantId, turnIndex: turn },
        ],
      });
      replaceNavigationTriples(stored, memory, [triple]);
    };
    addMemory(
      1,
      "季度汇报演示文稿使用品牌模板。",
      "季度汇报 PPT 使用哪个模板？",
      "季度汇报 PPT 使用品牌模板。",
      { subject: "季度汇报 PPT", predicate: "使用", object: "品牌模板" },
    );
    addMemory(
      2,
      "品牌模板的主题色是深海蓝。",
      "品牌模板的主题色是什么？",
      "主题色是深海蓝。",
      { subject: "品牌模板", predicate: "主题色", object: "深海蓝" },
    );
    addMemory(
      3,
      "晚餐选择了面条。",
      "晚餐吃什么？",
      "晚餐选择了面条。",
      { subject: "晚餐", predicate: "选择", object: "面条" },
    );
    detectNavigationCommunities(stored);
    stored.close();

    const agentListeners = new Map<string, Array<(...args: any[]) => any>>();
    const agent: any = {
      id: "current-session",
      session: { id: "current-session", events: [], surface: { nodes: [] } },
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
    const currentUser = {
      id: "current-user",
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: "深海蓝是什么模板的主题色？" }],
    };
    const decision = await agentListeners.get("agent/pre-step")![0]({
      agent,
      messages: [currentUser],
      signal: new AbortController().signal,
      step: 1,
    }, async () => ({ kind: "enter", messages: [currentUser] }));

    expect(decision.kind).toBe("enter");
    expect(decision.messages).toHaveLength(2);
    expect(decision.messages[0].source).toMatchObject({ kind: "plugin", plugin: "graph-memory" });
    const recalled = decision.messages[0].content[0].text;
    expect(recalled).toContain("季度汇报 PPT 使用品牌模板");
    expect(recalled).toContain("主题色是深海蓝");
    expect(recalled).toContain("<navigation_graph>");
    expect(recalled).not.toContain("晚餐选择了面条");
    expect(decision.messages[1]).toBe(currentUser);

    await Promise.all(cleanups.map(cleanup => cleanup()));
    rmSync(dir, { recursive: true, force: true });
  });
});

function userMsg(seq: number, text: string) {
  return {
    type: "user/message",
    seq,
    data: { id: `u${seq}`, role: "user", source: { kind: "user" }, content: [{ type: "text", text }] },
  };
}

const EMPTY_EXTRACTION = '{"summary":"question was answered","outcome":"informational","triples":[]}';
const TURN_TWO_EMPTY_EXTRACTION = '{"summary":"new question was answered","outcome":"informational","triples":[]}';

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
    expect(requests[0].tools[0].parameters.required).toEqual(["summary", "outcome", "triples"]);
    const prompt = requests[0].messages[0].content[0].text;
    expect(prompt).toContain("What should we remember?");
    expect(prompt).toContain("Remember the verified final result.");
    expect(prompt).not.toContain("private chain of thought");
    expect(prompt).not.toContain("large tool output");
    expect(prompt).not.toContain("final hidden reasoning");
    expect(prompt).not.toContain("Graph Memory");
    expect(prompt).not.toContain("TASK");
    expect(prompt).not.toContain("SKILL");
    expect(prompt).not.toContain("EVENT");
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

  it("uses prior summaries to resolve the next turn and keeps corrections chronological", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gm-temporal-revision-"));
    const dbPath = join(dir, "graph-memory.db");
    const requests: any[] = [];
    const outputs = [
      JSON.stringify({
        summary: "项目端口确认为 8080。",
        outcome: "informational",
        triples: [{ subject: "项目端口", predicate: "确认为", object: "8080" }],
      }),
      JSON.stringify({
        summary: "项目端口从 8080 修订为 9090。",
        outcome: "completed",
        triples: [{ subject: "项目端口", predicate: "修订为", object: "9090" }],
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
    expect(secondPrompt).toContain("<Previous Turn Summaries>");
    expect(secondPrompt).toContain("项目端口确认为 8080");
    expect(secondPrompt).not.toContain("revision-session");
    expect(secondPrompt).not.toContain("t=");
    const inspect = new DatabaseSync(dbPath);
    try {
      const timeline = inspect.prepare(`
        SELECT memory.summary, triple.predicate, object.display_text AS object
        FROM gm_turn_memories memory
        JOIN gm_navigation_triples triple ON triple.memory_id=memory.id
        JOIN gm_navigation_terms object ON object.id=triple.object_id
        ORDER BY memory.created_at, memory.rowid
      `).all() as Array<{ summary: string; predicate: string; object: string }>;
      expect(timeline).toEqual([
        { summary: "项目端口确认为 8080。", predicate: "确认为", object: "8080" },
        { summary: "项目端口从 8080 修订为 9090。", predicate: "修订为", object: "9090" },
      ]);
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
