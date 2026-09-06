import { afterEach, describe, expect, it, vi } from "vitest";

// ── 模块隔离：register() 的完整初始化路径绝不能触碰真实 Neo4j ──
// 不 mock 的话 getDriver() 会连 bolt://localhost:7687，initSchema 还会执行
// 真实 DDL —— 任何 7687 端口有真实库的机器上裸跑 `npm test` 都有写风险。
vi.mock("../src/store/db.ts", () => ({
  getDriver: () => ({}),
  initSchema: async () => {},
  getSession: () => ({ close: async () => {} }),
  closeDriver: async () => {},
}));

vi.mock("../src/store/store.ts", () => ({
  saveMessage: async () => {},
  getUnextracted: async () => [],
  getMaxTurnIndex: async () => 0,
  markExtracted: async () => {},
  isTurnExtracted: async () => false,
  upsertNode: async () => ({ node: {}, isNew: false }),
  upsertEdge: async () => {},
  findByName: async () => null,
  updateNode: async () => null,
  deprecateNodeAndDisconnect: async () => {},
  deprecateNodeAndDisconnectById: async () => {},
  getBySession: async () => [],
  edgesFrom: async () => [],
  edgesTo: async () => [],
  edgesTouching: async () => [],
  deleteEdges: async () => {},
  mergeNodes: async () => {},
  getStats: async () => ({}),
}));

// resolveProvider 必须是真实实现：baseUrl 归一化的用例断言的就是它的推断告警。
// 只替换 createCompleteFn（真实实现会发起 HTTP / 触发 OAuth 文件读取）。
vi.mock("../src/engine/llm.ts", async (importActual) => {
  const actual = await importActual<typeof import("../src/engine/llm.ts")>();
  return {
    ...actual,
    createCompleteFn: () => async () => "",
  };
});

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
  parseTimeRange: () => null,
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
import { closeDriver } from "../src/store/db.ts";

/** 完整运行时模式的 fake api（覆盖 register() 用到的全部方法）。 */
function fullApi(pluginConfig: Record<string, unknown> = {}) {
  return {
    pluginConfig,
    config: {},
    resolvePath: (v: string) => v,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    registerCli: vi.fn(),
    registerTool: vi.fn(),
    registerContextEngine: vi.fn(),
    registerHttpRoute: vi.fn(),
    on: vi.fn(),
  } as any;
}

describe("duplicate register() guard", () => {
  let createdEngine: { dispose: () => Promise<void> } | null = null;

  afterEach(async () => {
    if (createdEngine) {
      await createdEngine.dispose();
      createdEngine = null;
    }
    await closeDriver();
  });

  it("reuses the active engine when the host registers twice without dispose", () => {
    const api1 = fullApi();
    graphMemoryProPlugin.register(api1);
    expect(api1.registerContextEngine).toHaveBeenCalledTimes(1);
    createdEngine = api1.registerContextEngine.mock.calls[0][1]();

    // 第二次 register：只重绑引擎工厂，不再注册工具/路由/hook
    const api2 = fullApi();
    graphMemoryProPlugin.register(api2);
    expect(api2.registerContextEngine).toHaveBeenCalledTimes(1);
    expect(api2.registerTool).not.toHaveBeenCalled();
    expect(api2.registerHttpRoute).not.toHaveBeenCalled();
    expect(api2.on).not.toHaveBeenCalled();
    expect(api2.registerContextEngine.mock.calls[0][1]()).toBe(createdEngine);
    expect(api2.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("duplicate register() ignored"),
    );
  });

  // 2026-09-01 事故回归：host 逐逻辑 turn 惰性调用工厂。守卫曾把工厂重绑为
  // `() => activeEngine`（可变模块变量），dispose() 清空标记后工厂返回 null，
  // host 按契约判定 "factory returned null" 并逐回合降级 legacy 直到重启。
  it("rebound factory still returns the engine after dispose clears the module flag", async () => {
    const api1 = fullApi();
    graphMemoryProPlugin.register(api1);
    const engineA = api1.registerContextEngine.mock.calls[0][1]();
    createdEngine = engineA;

    const api2 = fullApi();
    graphMemoryProPlugin.register(api2); // 守卫路径重绑工厂
    const reboundFactory = api2.registerContextEngine.mock.calls[0][1];

    await engineA.dispose(); // activeEngine → null

    expect(reboundFactory()).toBe(engineA);
    expect(reboundFactory()).not.toBeNull();
  });

  it("skips runtime init for discovery-mode loads (readOnlyDiscovery never serves turns)", () => {
    const api1 = fullApi();
    graphMemoryProPlugin.register(api1);
    createdEngine = api1.registerContextEngine.mock.calls[0][1]();

    // 配置热重载的 discovery 加载：只重注册 CLI 元数据，不碰运行时，
    // 也不与活跃引擎守卫交互（mode 检查在守卫之前）
    const api2 = fullApi();
    api2.registrationMode = "discovery";
    graphMemoryProPlugin.register(api2);
    expect(api2.registerCli).toHaveBeenCalledOnce();
    expect(api2.registerContextEngine).not.toHaveBeenCalled();
    expect(api2.registerTool).not.toHaveBeenCalled();
    expect(api2.on).not.toHaveBeenCalled();
  });

  it("creates a fresh engine after dispose() (genuine reload)", async () => {
    const api1 = fullApi();
    graphMemoryProPlugin.register(api1);
    const engineA = api1.registerContextEngine.mock.calls[0][1]();
    createdEngine = engineA;
    await engineA.dispose();

    const api2 = fullApi();
    graphMemoryProPlugin.register(api2);
    const engineB = api2.registerContextEngine.mock.calls[0][1]();
    expect(engineB).not.toBe(engineA);
    expect(api2.registerTool).toHaveBeenCalled();
    // afterEach 清理的是"最后创建"的引擎（engineB 才是当前活跃的）
    createdEngine = engineB;
  });

  it("normalizes lowercase llm.baseUrl to baseURL before provider resolution", () => {
    // 只有 apiKey 时启发式推断为 anthropic；归一生效后 baseURL 存在 → 推断为 openai
    const api = fullApi({ llm: { apiKey: "k", baseUrl: "http://localhost:8080/v1/" } });
    graphMemoryProPlugin.register(api);
    createdEngine = api.registerContextEngine.mock.calls[0]?.[1]?.() ?? null;

    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('推断为 "openai"'),
    );
  });

  it("explicit baseURL wins over baseUrl spelling", () => {
    const api = fullApi({
      llm: { apiKey: "k", baseURL: "http://explicit/v1", baseUrl: "http://lowercase/v1" },
    });
    graphMemoryProPlugin.register(api);
    createdEngine = api.registerContextEngine.mock.calls[0]?.[1]?.() ?? null;

    // 显式配置优先 —— 这里只验证 register 未被拼写兼容逻辑破坏（推断告警产生一次）
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('推断为 "openai"'),
    );
    expect(
      api.logger.warn.mock.calls.filter((args: unknown[]) =>
        String(args[0]).includes("llm.provider 未显式设置"),
      ),
    ).toHaveLength(1);
  });
});
