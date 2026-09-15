import { afterAll, describe, expect, it, vi } from "vitest";

// ── 归档冲洗：session:patch 内部 hook → batched 尾批提取 ──
//
// 归档（CLI `openclaw sessions archive` / Control UI）= gateway RPC
// `sessions.patch { archived: true }`，不派发任何 typed hook（session_end
// 的 reason 枚举没有 archived）。宿主在 patch 提交后派发内部 hook
// session:patch，插件经 api.registerHook 接收并冲洗该会话的提取尾批。
// 本文件：batched 模式下归档事件端到端触发提取 + 纯函数过滤规则。

const storeState = {
  unextracted: [] as Array<{ session_id: string; turn_index: number; role: string; content: string }>,
  markExtractedCalls: [] as Array<{ sessionId: string; maxTurn: number }>,
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
  markExtracted: async (_driver: unknown, sessionId: string, maxTurn: number) => {
    storeState.markExtractedCalls.push({ sessionId, maxTurn });
    // 模拟前缀标记语义：已提取消息不再出现在未提取集
    storeState.unextracted = storeState.unextracted.filter((m) => m.turn_index > maxTurn);
  },
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

const extractCalls: Array<{ messages: unknown[] }> = [];

vi.mock("../src/extractor/extract.ts", () => ({
  Extractor: class {
    async extract(input: { messages: unknown[] }) {
      extractCalls.push({ messages: input.messages });
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

import graphMemoryProPlugin, { archiveSessionIdFromPatchEvent } from "../index.ts";

type CapturedHook = {
  events: string | string[];
  handler: (event: any) => Promise<void> | void;
  opts?: { name?: string };
};

let activeEngine: { dispose?: () => Promise<void> | void } | null = null;
afterAll(async () => {
  // singleFork 共享进程：清掉模块级 activeEngine，不把注册状态泄漏给后续文件
  await activeEngine?.dispose?.();
  activeEngine = null;
});

function makeArchiveEvent(sessionId: string | undefined, patch: Record<string, unknown>) {
  return {
    type: "session",
    action: "patch",
    sessionKey: "agent:main:scratch-1",
    context: {
      patch,
      sessionEntry: sessionId === undefined ? {} : { sessionId },
    },
    timestamp: new Date(),
    messages: [],
  };
}

describe("session:patch 归档冲洗（batched 模式）", () => {
  it("归档 patch 触发尾批提取；非归档/重复/畸形事件过滤", async () => {
    const hooks: CapturedHook[] = [];
    let engine: any;
    graphMemoryProPlugin.register({
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      config: {},
      pluginConfig: { extract: { mode: "batched" } },
      resolvePath: (path: string) => path,
      on: () => {},
      registerHook: (events, handler, opts) => { hooks.push({ events, handler, opts }); },
      registerContextEngine: (_id: string, factory: () => any) => { engine = factory(); },
      registerTool: () => {},
      registerHttpRoute: () => {},
    });
    if (!engine) throw new Error("context engine was not registered");
    activeEngine = engine;

    const hook = hooks.find((h) => h.events === "session:patch");
    expect(hook, "session:patch hook was not registered").toBeDefined();
    expect(hook?.opts?.name).toBe("graph-memory-archive-flush");

    // 攒批未达阈值的尾批（2 条 < compactTurnCount*3 = 18，batched 模式不会在轮边界提取）
    storeState.unextracted = [
      { session_id: "sess-a", turn_index: 1, role: "user", content: "部署 pnpm monorepo 时报错" },
      { session_id: "sess-a", turn_index: 2, role: "assistant", content: "用 workspace 协议解决" },
    ];

    await hook!.handler(makeArchiveEvent("sess-a", { archived: true }));

    expect(extractCalls).toHaveLength(1);
    expect(storeState.markExtractedCalls).toEqual([
      { sessionId: "sess-a", maxTurn: 2 },
    ]);

    // 已冲洗干净后再次归档：无未提取消息 → no-op
    await hook!.handler(makeArchiveEvent("sess-a", { archived: true }));
    expect(extractCalls).toHaveLength(1);

    // 模型切换等其他 patch：session:patch 的通用通知，必须被过滤
    await hook!.handler(makeArchiveEvent("sess-a", { model: "anthropic/claude-x" }));
    await hook!.handler(makeArchiveEvent("sess-a", { archived: false }));
    expect(extractCalls).toHaveLength(1);

    // 无 durable identity（无 sessionId）/ 空 context：防御性跳过，不抛错
    await expect(hook!.handler(makeArchiveEvent(undefined, { archived: true }))).resolves.toBeUndefined();
    await expect(hook!.handler({ type: "session", action: "patch" })).resolves.toBeUndefined();
    expect(extractCalls).toHaveLength(1);
  });
});

describe("archiveSessionIdFromPatchEvent（纯函数过滤规则）", () => {
  it("仅 archived:true 且带 sessionId 的 patch 命中", () => {
    expect(archiveSessionIdFromPatchEvent(makeArchiveEvent("s1", { archived: true }))).toBe("s1");
  });

  it("非归档 patch 全部返回 null", () => {
    expect(archiveSessionIdFromPatchEvent(makeArchiveEvent("s1", { model: "x" }))).toBeNull();
    expect(archiveSessionIdFromPatchEvent(makeArchiveEvent("s1", { archived: false }))).toBeNull();
    expect(archiveSessionIdFromPatchEvent(makeArchiveEvent(undefined, { archived: true }))).toBeNull();
  });

  it("畸形输入返回 null 不抛错", () => {
    expect(archiveSessionIdFromPatchEvent(null)).toBeNull();
    expect(archiveSessionIdFromPatchEvent(undefined)).toBeNull();
    expect(archiveSessionIdFromPatchEvent("session:patch")).toBeNull();
    expect(archiveSessionIdFromPatchEvent({ context: null })).toBeNull();
    expect(archiveSessionIdFromPatchEvent({ context: { patch: { archived: true } } })).toBeNull();
    expect(archiveSessionIdFromPatchEvent({ context: { patch: { archived: true }, sessionEntry: { sessionId: 42 } } })).toBeNull();
  });
});
