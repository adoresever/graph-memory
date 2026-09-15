import { afterAll, describe, expect, it, vi } from "vitest";

// ── 归档冲洗门控：per-turn 模式不冲洗 ──
//
// 与 session_end 尾批冲洗保持同门：只有 batched 模式存在"攒批未达阈值的
// 尾批"，per-turn 模式轮边界即时提取、无攒批语义，归档事件应为 no-op。
// 独立文件是因为模块级 activeEngine 防重复注册——需要独立模块图换取
// 另一个 extract.mode 的 register() 实例（与 archive-flush.test.ts 的
// batched 用例互不污染）。

const storeState = {
  unextracted: [] as Array<{ session_id: string; turn_index: number; role: string; content: string }>,
};

vi.mock("../src/store/db.ts", () => ({
  getDriver: () => ({}),
  initSchema: async () => {},
  getSession: () => ({ close: async () => {} }),
  closeDriver: async () => {},
}));

vi.mock("../src/store/store.ts", () => ({
  saveMessage: async () => {},
  getUnextracted: async () => storeState.unextracted,
  countUnextracted: async () => storeState.unextracted.length,
  getMaxTurnIndex: async () => 0,
  markExtracted: async () => {},
  isTurnExtracted: async () => false,
  commitTurnAdvance: async () => ({ status: "committed" }),
  upsertNode: async () => ({ node: {}, isNew: false }),
  upsertEdge: async () => {},
  findByName: async () => null,
  updateNode: async () => null,
  deprecateNodeAndDisconnect: async () => {},
  deprecateNodeAndDisconnectById: async () => {},
  getBySession: async () => [],
  edgesTouching: async () => [],
  topNodes: async () => [],
  deleteEdges: async () => {},
  mergeNodes: async () => {},
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
    async recall() { return { nodes: [], edges: [] }; }
    async syncEmbed(): Promise<void> {}
    async syncEmbedBatch(): Promise<void> {}
  },
  parseTimeRange: () => null,
}));

const extractCalls: Array<unknown> = [];

vi.mock("../src/extractor/extract.ts", () => ({
  Extractor: class {
    async extract() {
      extractCalls.push({});
      return { nodes: [], edges: [] };
    }
    async finalize() { return { promotedSkills: [], newEdges: [], invalidations: [] }; }
  },
  shouldRunFinalize: () => false,
}));

vi.mock("../src/extractor/persist.ts", () => ({
  persistExtractionResult: async () => ({ nodes: [], edges: 0, updatedExisting: 0 }),
}));

vi.mock("../src/format/assemble.ts", () => ({
  assembleContext: async () => ({ xml: "", systemPrompt: "", tokens: 0 }),
}));

vi.mock("../src/graph/maintenance.ts", () => ({
  runMaintenance: async () => ({ durationMs: 0 }),
}));

vi.mock("../src/routes/crud.ts", () => ({
  registerCrudRoutes: () => {},
}));

import graphMemoryProPlugin from "../index.ts";

let activeEngine: { dispose?: () => Promise<void> | void } | null = null;
afterAll(async () => {
  await activeEngine?.dispose?.();
  activeEngine = null;
});

describe("session:patch 归档冲洗（per-turn 模式门控）", () => {
  it("默认 per-turn 模式下归档事件为 no-op", async () => {
    const hooks: Array<{
      events: string | string[];
      handler: (event: any) => Promise<void> | void;
    }> = [];
    let engine: any;
    graphMemoryProPlugin.register({
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      config: {},
      pluginConfig: {}, // 默认 extract.mode = per-turn
      resolvePath: (path: string) => path,
      on: () => {},
      registerHook: (events, handler) => { hooks.push({ events, handler }); },
      registerContextEngine: (_id: string, factory: () => any) => { engine = factory(); },
      registerTool: () => {},
      registerHttpRoute: () => {},
    });
    if (!engine) throw new Error("context engine was not registered");
    activeEngine = engine;

    const hook = hooks.find((h) => h.events === "session:patch");
    if (!hook) throw new Error("session:patch hook was not registered");

    storeState.unextracted = [
      { session_id: "sess-b", turn_index: 1, role: "user", content: "hello" },
    ];

    await hook.handler({
      type: "session",
      action: "patch",
      sessionKey: "agent:main:scratch-2",
      context: { patch: { archived: true }, sessionEntry: { sessionId: "sess-b" } },
      timestamp: new Date(),
      messages: [],
    });

    expect(extractCalls).toHaveLength(0);
  });
});
