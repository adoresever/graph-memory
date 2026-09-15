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
  saveMessage: vi.fn(async () => {}),
  getUnextracted: async () => [],
  getMaxTurnIndex: async () => 0,
  markExtracted: vi.fn(async () => {}),
  isTurnExtracted: vi.fn(async () => false),
  commitTurnAdvance: vi.fn(async () => "committed" as const),
  upsertNode: async () => ({ node: {}, isNew: false }),
  upsertEdge: async () => {},
  findByName: async () => null,
  updateNode: async () => null,
  deprecateNodeAndDisconnect: async () => {},
  deprecateNodeAndDisconnectById: async () => {},
  getBySession: async () => [],
  edgesTouching: async () => [],
  deleteEdges: async () => {},
  mergeNodes: async () => {},
  getStats: async () => ({}),
}));

vi.mock("../src/engine/llm.ts", () => ({
  createCompleteFn: () => async () => "",
  resolveProvider: () => ({ provider: "anthropic", inferred: false }),
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
import { commitTurnAdvance, isTurnExtracted, markExtracted, saveMessage } from "../src/store/store.ts";

const commitMock = vi.mocked(commitTurnAdvance);
const isTurnExtractedMock = vi.mocked(isTurnExtracted);
const markExtractedMock = vi.mocked(markExtracted);
const saveMessageMock = vi.mocked(saveMessage);

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

function buildEngine(pluginConfig: Record<string, unknown> = {}) {
  const api = fullApi(pluginConfig);
  graphMemoryProPlugin.register(api);
  const engine = api.registerContextEngine.mock.calls[0][1]() as any;
  return { api, engine };
}

/** 轮询等待 fire-and-forget 的提取管线真正跑起来。 */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("commitTurn (OpenClaw transcript fencing contract)", () => {
  let engine: any;
  let api: any;

  afterEach(async () => {
    if (engine) {
      await engine.dispose();
      engine = null;
    }
    await closeDriver();
    commitMock.mockReset();
    commitMock.mockResolvedValue("committed");
    isTurnExtractedMock.mockClear();
    markExtractedMock.mockClear();
    saveMessageMock.mockClear();
  });

  it("declares current-turn transcript fencing semantics in engine.info", () => {
    ({ api, engine } = buildEngine());
    expect(engine.info.transcriptSemantics).toEqual({
      currentTurnFence: "before-current-turn-entry-v1",
      turnAdvancementIdempotency: "atomic-idempotent-v1",
    });
  });

  it("returns committed on first write and schedules turn extraction", async () => {
    ({ api, engine } = buildEngine());
    const res = await engine.commitTurn({
      sessionId: "s-commit-1",
      sessionKey: "agent:t:session-1",
      advancementKey: "adv-key-1",
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }],
    });
    expect(res).toEqual({ status: "committed" });
    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(commitMock.mock.calls[0][2]).toBe("adv-key-1");
    expect(commitMock.mock.calls[0][3]).toBe(2);

    // 提取是 fire-and-forget，但最终必须进入 isTurnExtracted 幂等检查
    await until(() => isTurnExtractedMock.mock.calls.length > 0);
  });

  it("returns duplicate on host retry without replaying side effects", async () => {
    ({ api, engine } = buildEngine());
    commitMock.mockResolvedValueOnce("committed");
    commitMock.mockResolvedValueOnce("duplicate");

    const first = await engine.commitTurn({
      sessionId: "s-commit-2", advancementKey: "adv-key-2", messages: [{ role: "user", content: "q" }],
    });
    const retry = await engine.commitTurn({
      sessionId: "s-commit-2", advancementKey: "adv-key-2", messages: [{ role: "user", content: "q" }],
    });
    expect(first).toEqual({ status: "committed" });
    expect(retry).toEqual({ status: "duplicate" });
    expect(commitMock).toHaveBeenCalledTimes(2);

    // duplicate 短路后不得再触发提取：先等首次提交的提取管线完整落地
    // （markExtracted 是管线最后一步），再确认 retry 没有安排新的提取
    await until(() => markExtractedMock.mock.calls.length > 0);
    const settledCalls = markExtractedMock.mock.calls.length;
    isTurnExtractedMock.mockClear();
    await new Promise((r) => setTimeout(r, 100));
    expect(isTurnExtractedMock).not.toHaveBeenCalled();
    expect(markExtractedMock.mock.calls.length).toBe(settledCalls);
  });

  it("degrades to committed when the marker write fails (non-constraint error)", async () => {
    ({ api, engine } = buildEngine());
    commitMock.mockRejectedValueOnce(new Error("pool closed"));
    const res = await engine.commitTurn({
      sessionId: "s-commit-3", advancementKey: "adv-key-3", messages: [],
    });
    expect(res).toEqual({ status: "committed" });
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("commitTurn marker write failed"),
    );
  });

  it("no-ops for heartbeats and missing advancementKey", async () => {
    ({ api, engine } = buildEngine());
    expect(await engine.commitTurn({ sessionId: "s", advancementKey: "k", isHeartbeat: true }))
      .toEqual({ status: "committed" });
    expect(await engine.commitTurn({ sessionId: "s", messages: [] }))
      .toEqual({ status: "committed" });
    expect(commitMock).not.toHaveBeenCalled();
  });

  it("skips the marker entirely for cron sessions with cron.enabled=false", async () => {
    ({ api, engine } = buildEngine({ cron: { enabled: false } }));
    const res = await engine.commitTurn({
      sessionId: "s-cron-1",
      sessionKey: "agent:main:cron:job-1",
      advancementKey: "adv-cron-1",
      messages: [{ role: "user", content: "tick" }],
    });
    expect(res).toEqual({ status: "committed" });
    expect(commitMock).not.toHaveBeenCalled();
    expect(isTurnExtractedMock).not.toHaveBeenCalled();
  });

  it("never persists messages itself — persistence stays with ingest/afterTurn", async () => {
    // 设计决策的回归钉子：commitTurn 若也开始落消息，与 afterTurn 并存时
    // 会以新 seq 重写整轮 → GmMessage 重复行
    ({ api, engine } = buildEngine());
    await engine.commitTurn({
      sessionId: "s-nopersist",
      advancementKey: "adv-nopersist",
      messages: [{ role: "user", content: "hello" }],
    });
    await until(() => isTurnExtractedMock.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(saveMessageMock).not.toHaveBeenCalled();
  });

  it("warns and skips marker + extraction when the session cannot be resolved", async () => {
    ({ api, engine } = buildEngine());
    const res = await engine.commitTurn({
      advancementKey: "adv-no-session",
      messages: [{ role: "user", content: "orphan" }],
    });
    expect(res).toEqual({ status: "committed" });
    expect(commitMock).not.toHaveBeenCalled();
    expect(isTurnExtractedMock).not.toHaveBeenCalled();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("cannot resolve session"),
    );
  });
});
