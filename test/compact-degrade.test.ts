import { afterAll, describe, expect, it, vi } from "vitest";

// 老宿主降级场景：plugin-sdk/core 存在但无 delegateCompactionToRuntime 导出
// （或子路径整个缺失）——动态 import 得到空命名空间，compact() 的可用性
// 检查走降级分支而非链接期崩溃。独立文件是因为 index.ts 的 delegate
// loader 是模块级 memoized，不能与正常 fixture 文件混用模块图。
vi.mock("openclaw/plugin-sdk/core", () => ({}));

vi.mock("../src/store/db.ts", () => ({
  getDriver: () => ({}),
  initSchema: async () => {},
  getSession: () => ({ close: async () => {} }),
  closeDriver: async () => {},
}));

vi.mock("../src/store/store.ts", () => ({
  saveMessage: async () => {},
  getUnextracted: async () => [],
  countUnextracted: async () => 0,
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
  },
}));

vi.mock("../src/extractor/extract.ts", () => ({
  Extractor: class {
    async extract() { return { nodes: [], edges: [] }; }
    async finalize() { return { promotedSkills: [], newEdges: [], invalidations: [] }; }
  },
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
  // singleFork 共享进程：清掉模块级 activeEngine，不把注册状态泄漏给后续文件
  await activeEngine?.dispose?.();
  activeEngine = null;
});

describe("compact delegating 降级（老宿主无 delegateCompactionToRuntime）", () => {
  it("委托不可用时返回结构化降级结果，不向宿主抛错", async () => {
    let engine: any;
    graphMemoryProPlugin.register({
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      config: {},
      pluginConfig: {},
      resolvePath: (path: string) => path,
      on: () => {},
      registerContextEngine: (_id: string, factory: () => any) => { engine = factory(); },
      registerTool: () => {},
      registerHttpRoute: () => {},
    });
    if (!engine) throw new Error("context engine was not registered");
    activeEngine = engine;

    await expect(engine.compact({ sessionId: "degrade-1" })).resolves.toEqual({
      ok: true,
      compacted: false,
      reason: "runtime delegation unavailable",
    });
  });
});
