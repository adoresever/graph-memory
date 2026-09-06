import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isCronSessionKey } from "../src/types.ts";

const mocks = vi.hoisted(() => ({
  getBySession: vi.fn(async () => [] as unknown[]),
  saveMessage: vi.fn(async (
    _driver: unknown, _sid: string, _turn: number, _role: string, _content: unknown,
  ): Promise<void> => {}),
  getMaxTurnIndex: vi.fn(async () => 0),
  getUnextracted: vi.fn(async () => []),
  isTurnExtracted: vi.fn(async () => false),
  recall: vi.fn(async () => ({
    nodes: [{ id: "recalled-node" }],
    edges: [],
  })),
  assembleContext: vi.fn(async () => ({ xml: "", systemPrompt: "", tokens: 0 })),
  runMaintenance: vi.fn(async () => ({
    durationMs: 0,
    dedup: { merged: 0 },
    community: { count: 0 },
    communitySummaries: 0,
    pagerank: { topK: [] },
  })),
}));

vi.mock("../src/store/db.ts", () => ({
  getDriver: () => ({}),
  initSchema: async () => {},
  getSession: () => ({ close: async () => {} }),
  closeDriver: async () => {},
}));

vi.mock("../src/store/store.ts", () => ({
  saveMessage: mocks.saveMessage,
  getUnextracted: mocks.getUnextracted,
  getMaxTurnIndex: mocks.getMaxTurnIndex,
  markExtracted: async () => {},
  isTurnExtracted: mocks.isTurnExtracted,
  upsertNode: async () => ({ node: {}, isNew: false }),
  upsertEdge: async () => {},
  findByName: async () => null,
  updateNode: async () => null,
  getBySession: mocks.getBySession,
  edgesFrom: async () => [],
  edgesTo: async () => [],
  edgesTouching: async () => [],
  deprecateNodeAndDisconnectById: async () => {},
  getStats: async () => ({}),
}));

vi.mock("../src/engine/llm.ts", () => ({
  createCompleteFn: () => async () => "",
  resolveProvider: () => ({ provider: "openai", inferred: false }),
}));

vi.mock("../src/engine/embed.ts", () => ({
    createEmbedder: async () => null,
}));

vi.mock("../src/recaller/recall.ts", () => ({
  Recaller: class {
    setEmbedFn(): void {}
    hasEmbedFn(): boolean { return false; }
    get embedFn() { return null; }
    async recall() { return mocks.recall(); }
    async syncEmbed(): Promise<void> {}
  },
}));

vi.mock("../src/extractor/extract.ts", () => ({
  Extractor: class {
    async extract() { return { nodes: [], edges: [] }; }
    async finalize() { return { promotedSkills: [], newEdges: [], invalidations: [] }; }
  },
}));

vi.mock("../src/format/assemble.ts", () => ({
  assembleContext: mocks.assembleContext,
}));

vi.mock("../src/graph/maintenance.ts", () => ({
  runMaintenance: mocks.runMaintenance,
}));

vi.mock("../src/routes/crud.ts", () => ({
  registerCrudRoutes: () => {},
}));

import graphMemoryProPlugin from "../index.ts";

type HookHandler = (event: Record<string, unknown>, context: Record<string, unknown>) => Promise<void>;
type EngineHarness = {
  readonly bootstrap: (params: { readonly sessionId: string; readonly sessionKey?: string }) => Promise<unknown>;
  readonly ingest: (params: {
    readonly sessionId: string;
    readonly sessionKey?: string;
    readonly message: unknown;
    readonly isHeartbeat?: boolean;
  }) => Promise<{ readonly ingested: boolean }>;
  readonly assemble: (params: {
    readonly sessionId: string;
    readonly sessionKey?: string;
    readonly messages: readonly unknown[];
  }) => Promise<unknown>;
  readonly compact: (params: { readonly sessionId: string; readonly sessionKey?: string }) => Promise<{
    readonly ok: boolean;
    readonly compacted: boolean;
    readonly reason?: string;
  }>;
  readonly afterTurn: (params: {
    readonly sessionId: string;
    readonly sessionKey?: string;
    readonly messages: readonly unknown[];
    readonly prePromptMessageCount: number;
  }) => Promise<void>;
  readonly prepareSubagentSpawn: (params: {
    readonly parentSessionKey: string;
    readonly childSessionKey: string;
    readonly parentSessionId?: string;
  }) => Promise<{ readonly rollback: () => void }>;
  readonly dispose: () => Promise<void>;
};

// register() 带防重复注册守卫（模块级 activeEngine）：同一进程内未 dispose 的
// 二次 register 会被拦截复用。本文件每个用例都注册一个带独立 pluginConfig
// 的隔离引擎 —— 在重复注册前先 dispose 上一个，保持逐用例隔离。
let previousEngine: { dispose?: () => Promise<void> | void } | null = null;

function registerPlugin(pluginConfig: Record<string, unknown> = {}): { readonly hooks: Map<string, HookHandler>; readonly engine: EngineHarness } {
  const hooks = new Map<string, HookHandler>();
  let engine: EngineHarness | undefined;
  previousEngine?.dispose?.();
  previousEngine = null;
  graphMemoryProPlugin.register({
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    config: {},
    pluginConfig,
    resolvePath: (path: string) => path,
    on: (event: string, handler: HookHandler) => { hooks.set(event, handler); },
    registerContextEngine: (_id: string, factory: () => EngineHarness) => { engine = factory(); },
    registerTool: () => {},
    registerHttpRoute: () => {},
  });
  if (!engine) throw new Error("context engine was not registered");
  previousEngine = engine;
  return { hooks, engine };
}

afterAll(async () => {
  // 释放最后一个引擎，清掉模块级 activeEngine —— vitest singleFork 下
  // 所有测试文件共享进程，不能把注册状态泄漏给后续文件
  await previousEngine?.dispose?.();
  previousEngine = null;
});

describe("session identity", () => {
  beforeEach(() => {
    mocks.getBySession.mockClear();
    mocks.recall.mockClear();
    mocks.assembleContext.mockClear();
    mocks.runMaintenance.mockClear();
  });

  it("finalizes the ended transcript sessionId instead of its routing sessionKey", async () => {
    const handler = registerPlugin().hooks.get("session_end");
    if (!handler) throw new Error("session_end hook was not registered");

    await handler(
      { sessionId: "ended-transcript", sessionKey: "agent:main" },
      { sessionId: "successor-transcript", sessionKey: "agent:main" },
    );

    expect(mocks.getBySession).toHaveBeenCalledWith({}, "ended-transcript");
  });

  it("transfers recalled context to a subagent by resolving its sessionKey to sessionId", async () => {
    const { hooks, engine } = registerPlugin();
    const beforeAgentStart = hooks.get("before_agent_start");
    if (!beforeAgentStart) throw new Error("before_agent_start hook was not registered");

    await beforeAgentStart(
      { prompt: "remember the parent context" },
      { sessionId: "parent-transcript", sessionKey: "agent:main" },
    );
    await engine.prepareSubagentSpawn({
      parentSessionId: "parent-transcript",
      parentSessionKey: "agent:main",
      childSessionKey: "agent:main:subagent:1",
    });
    await engine.bootstrap({
      sessionId: "child-transcript",
      sessionKey: "agent:main:subagent:1",
    });
    await engine.assemble({
      sessionId: "child-transcript",
      sessionKey: "agent:main:subagent:1",
      messages: [],
    });

    expect(mocks.assembleContext).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ recalledNodes: [{ id: "recalled-node" }] }),
    );
  });
});

describe("cron session gating (cron 配置)", () => {
  beforeEach(() => {
    mocks.getBySession.mockClear();
    mocks.saveMessage.mockClear();
    mocks.getMaxTurnIndex.mockClear();
    mocks.getUnextracted.mockClear();
    mocks.isTurnExtracted.mockClear();
    mocks.recall.mockClear();
    mocks.assembleContext.mockClear();
    mocks.runMaintenance.mockClear();
  });

  // host 契约：sessionId 是随机 transcript UUID，cron 标记在 sessionKey 上
  const CRON_KEY = "agent:agent-1:cron:daily-report";
  const CRON_SID = "0f1e2d3c-4b5a-6978-8976-543210fedcba";

  it("isCronSessionKey 按 sessionKey 段匹配 cron 标记", () => {
    expect(isCronSessionKey("cron:job-1")).toBe(true);
    expect(isCronSessionKey("agent:agent-1:cron:daily")).toBe(true);
    expect(isCronSessionKey("agent:agent-1:cron:daily:run:r1")).toBe(true);
    expect(isCronSessionKey("agent:main")).toBe(false);
    expect(isCronSessionKey("agent:cron-daily:main")).toBe(false);
    expect(isCronSessionKey("scheduled-cron:x")).toBe(false);
    expect(isCronSessionKey("")).toBe(false);
    expect(isCronSessionKey(undefined)).toBe(false);
    expect(isCronSessionKey(null)).toBe(false);
  });

  it("默认配置（全 true）下 cron session_end 仍执行 finalize 与图维护（向后兼容）", async () => {
    const handler = registerPlugin().hooks.get("session_end");
    if (!handler) throw new Error("session_end hook was not registered");

    await handler({ sessionId: CRON_SID, sessionKey: CRON_KEY }, {});

    expect(mocks.getBySession).toHaveBeenCalledWith({}, CRON_SID);
    expect(mocks.runMaintenance).toHaveBeenCalledTimes(1);
  });

  it("默认配置下 cron session 正常入库", async () => {
    const { engine } = registerPlugin();

    await expect(engine.ingest({ sessionId: CRON_SID, sessionKey: CRON_KEY, message: { role: "user", content: "hi" } }))
      .resolves.toEqual({ ingested: true });
    expect(mocks.saveMessage).toHaveBeenCalledTimes(1);
  });

  it("finalizeAndMaintain=false 时 cron session 跳过 finalize 与图维护", async () => {
    const handler = registerPlugin({ cron: { enabled: true, finalizeAndMaintain: false } }).hooks.get("session_end");
    if (!handler) throw new Error("session_end hook was not registered");

    await handler({ sessionId: CRON_SID, sessionKey: CRON_KEY }, {});

    expect(mocks.getBySession).not.toHaveBeenCalled();
    expect(mocks.runMaintenance).not.toHaveBeenCalled();
  });

  it("finalizeAndMaintain=true 时 cron session 执行 finalize 与图维护", async () => {
    const handler = registerPlugin({ cron: { enabled: true, finalizeAndMaintain: true } }).hooks.get("session_end");
    if (!handler) throw new Error("session_end hook was not registered");

    await handler({ sessionId: CRON_SID, sessionKey: CRON_KEY }, {});

    expect(mocks.getBySession).toHaveBeenCalledWith({}, CRON_SID);
    expect(mocks.runMaintenance).toHaveBeenCalledTimes(1);
  });

  it("finalizeAndMaintain=true 不影响普通会话的既有行为", async () => {
    const handler = registerPlugin({ cron: { enabled: true, finalizeAndMaintain: false } }).hooks.get("session_end");
    if (!handler) throw new Error("session_end hook was not registered");

    await handler({ sessionId: "normal-session", sessionKey: "agent:main" }, {});

    expect(mocks.runMaintenance).toHaveBeenCalledTimes(1);
  });

  it("enabled=false 时 cron session 不召回、不入库、不注入图谱上下文", async () => {
    const { hooks, engine } = registerPlugin({ cron: { enabled: false } });

    const beforeAgentStart = hooks.get("before_agent_start");
    if (!beforeAgentStart) throw new Error("before_agent_start hook was not registered");
    await beforeAgentStart({ prompt: "daily digest" }, { sessionKey: CRON_KEY });
    expect(mocks.recall).not.toHaveBeenCalled();

    await expect(engine.ingest({ sessionId: CRON_SID, sessionKey: CRON_KEY, message: { role: "user", content: "hi" } }))
      .resolves.toEqual({ ingested: false });
    expect(mocks.saveMessage).not.toHaveBeenCalled();

    await engine.assemble({ sessionId: CRON_SID, sessionKey: CRON_KEY, messages: [] });
    expect(mocks.assembleContext).not.toHaveBeenCalled();
  });

  it("enabled=false 总开关：cron afterTurn 跳过入库回填，compact 跳过提取", async () => {
    const { engine } = registerPlugin({ cron: { enabled: false } });

    await engine.afterTurn({
      sessionId: CRON_SID,
      sessionKey: CRON_KEY,
      messages: [{ role: "user", content: "hi" }],
      prePromptMessageCount: 0,
    });
    expect(mocks.saveMessage).not.toHaveBeenCalled();
    expect(mocks.isTurnExtracted).not.toHaveBeenCalled();

    const res = await engine.compact({ sessionId: CRON_SID, sessionKey: CRON_KEY });
    expect(res).toEqual({ ok: true, compacted: false, reason: "cron session graph disabled" });
    expect(mocks.getUnextracted).not.toHaveBeenCalled();
  });

  it("enabled=true 时 cron session 正常入库", async () => {
    const { engine } = registerPlugin({ cron: { enabled: true } });

    await engine.ingest({ sessionId: CRON_SID, sessionKey: CRON_KEY, message: { role: "user", content: "hi" } });

    expect(mocks.saveMessage).toHaveBeenCalledTimes(1);
  });

  it("extract=false 时 cron session 消息仍入库缓冲但不触发提取", async () => {
    const { engine } = registerPlugin({ cron: { enabled: true, extract: false } });

    await engine.afterTurn({
      sessionId: CRON_SID,
      sessionKey: CRON_KEY,
      messages: [{ role: "user", content: "hi" }],
      prePromptMessageCount: 0,
    });

    expect(mocks.saveMessage).toHaveBeenCalledTimes(1);
    expect(mocks.isTurnExtracted).not.toHaveBeenCalled();
  });

  it("extract=true 时 cron session 触发提取", async () => {
    const { engine } = registerPlugin({ cron: { enabled: true, extract: true } });

    await engine.afterTurn({
      sessionId: CRON_SID,
      sessionKey: CRON_KEY,
      messages: [{ role: "user", content: "hi" }],
      prePromptMessageCount: 0,
    });
    // afterTurn 内的 extractTurnKnowledge 是 fire-and-forget，flush 微任务后再断言
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mocks.isTurnExtracted).toHaveBeenCalledTimes(1);
  });

  it("extract=false 时 cron session compact 直接跳过提取", async () => {
    const { engine } = registerPlugin({ cron: { enabled: true, extract: false } });

    const res = await engine.compact({ sessionId: CRON_SID, sessionKey: CRON_KEY });

    expect(res).toEqual({ ok: true, compacted: false, reason: "cron session extraction disabled" });
    expect(mocks.getUnextracted).not.toHaveBeenCalled();
  });

  it("cron 任务设置自定义 sessionKey（无 cron 段）时按普通会话处理", async () => {
    const { engine } = registerPlugin({ cron: { enabled: false } });

    await expect(engine.ingest({ sessionId: CRON_SID, sessionKey: "agent:my-custom-key", message: { role: "user", content: "hi" } }))
      .resolves.toEqual({ ingested: true });

    expect(mocks.saveMessage).toHaveBeenCalledTimes(1);
  });
});

describe("outage buffering (Neo4j 掉线缓冲)", () => {
  beforeEach(() => {
    // mockReset：清掉上一个测试可能设置的 mockRejectedValue 等持久实现，
    // 否则持续拒绝会泄漏到后续测试，把所有消息都打进缓冲
    mocks.saveMessage.mockReset().mockImplementation(async () => {});
    mocks.saveMessage.mockClear();
    mocks.getUnextracted.mockClear();
    mocks.getMaxTurnIndex.mockClear();
  });

  it("写失败时消息被缓冲且不向 host 抛错", async () => {
    const { engine } = registerPlugin();
    mocks.saveMessage.mockRejectedValue(new Error("neo4j down"));

    await expect(
      engine.ingest({ sessionId: "outage-1", message: { role: "user", content: "hello" } }),
    ).resolves.toEqual({ ingested: true });

    expect(mocks.saveMessage).toHaveBeenCalledTimes(1);
  });

  it("恢复后缓冲消息经 ingestMessage 补写（seq 由 DB 状态分配，不撞号）", async () => {
    const { engine } = registerPlugin();
    mocks.saveMessage.mockRejectedValueOnce(new Error("neo4j down"));

    // 第一条：写失败 → 缓冲（seq 1 被失败尝试消耗）
    await engine.ingest({ sessionId: "outage-2", message: { role: "user", content: "first message" } });
    // 第二条：写成功 → 触发 flush → 第一条补写（分配新 seq，绕开撞号）
    await engine.ingest({ sessionId: "outage-2", message: { role: "user", content: "second message" } });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mocks.saveMessage).toHaveBeenCalledTimes(3);
    const flushed = mocks.saveMessage.mock.calls[2];
    expect(flushed[1]).toBe("outage-2");
    expect(flushed[2]).toBe(3); // seq 3 = max(已写 2) + 1，而非缓冲期的 1
    expect((flushed[4] as { content: string }).content).toContain("first message");
  });

  it("不可序列化的消息被丢弃，不堵塞后续消息（队头防堵）", async () => {
    const { engine } = registerPlugin();
    // 先让写失败一次，把毒消息逼进缓冲路径（真实 saveMessage 会在 stringify 时抛错）
    mocks.saveMessage.mockRejectedValueOnce(new Error("neo4j down"));

    const poison: any = { role: "user", content: "ok" };
    poison.self = poison; // 循环引用 → JSON.stringify 抛错

    await expect(
      engine.ingest({ sessionId: "outage-3", message: poison }),
    ).resolves.toEqual({ ingested: true });
    await expect(
      engine.ingest({ sessionId: "outage-3", message: { role: "user", content: "after poison" } }),
    ).resolves.toEqual({ ingested: true });
    await new Promise(resolve => setTimeout(resolve, 0));

    // 第一次 saveMessage 因序列化失败抛错 → 消息进缓冲即被丢弃；
    // 第二条正常直写后 flush 无积压 → 总共 2 次调用，毒消息不重试
    expect(mocks.saveMessage).toHaveBeenCalledTimes(2);
  });

  it("compact 在读取未提取消息前先刷缓冲（恢复补提取顺序）", async () => {
    const { engine } = registerPlugin();
    mocks.saveMessage.mockRejectedValueOnce(new Error("neo4j down"));

    await engine.ingest({ sessionId: "outage-4", message: { role: "user", content: "buffered turn" } });
    expect(mocks.saveMessage).toHaveBeenCalledTimes(1);

    const res = await engine.compact({ sessionId: "outage-4" });
    expect(res).toEqual({ ok: true, compacted: false, reason: "no messages" });

    // flush 先于 getUnextracted：第二条 saveMessage 是缓冲补写，然后才查未提取集
    expect(mocks.saveMessage).toHaveBeenCalledTimes(2);
    expect((mocks.saveMessage.mock.calls[1][4] as { content: string }).content).toContain("buffered turn");
    expect(mocks.getUnextracted).toHaveBeenCalledTimes(1);
  });
});
