import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listUnextractedSessions: vi.fn(async () => [] as any[]),
  getUnextracted: vi.fn(async (_d: any, _sid: any, _limit: any) => [] as any[]),
  markExtracted: vi.fn(async () => {}),
  upsertNode: vi.fn(async (_driver: any, c: any) => ({
    node: {
      id: `n-${c.name}`,
      type: c.type,
      name: c.name,
      description: c.description ?? "",
      content: c.content,
      status: "active",
      validatedCount: 1,
      sourceSessions: [],
      communityId: null,
      pagerank: 0,
      createdAt: 0,
      updatedAt: 0,
    },
    isNew: true,
  })),
  upsertEdge: vi.fn(async () => {}),
  findByName: vi.fn(async () => null),
  getBySession: vi.fn(async () => [] as any[]),
  extract: vi.fn(async () => ({ nodes: [] as any[], edges: [] as any[] })),
  initSchema: vi.fn(async () => {}),
  closeDriver: vi.fn(async () => {}),
}));

vi.mock("../src/store/db.ts", () => ({
  getDriver: () => ({}),
  initSchema: mocks.initSchema,
  getSession: () => ({ close: async () => {} }),
  closeDriver: mocks.closeDriver,
}));

vi.mock("../src/store/store.ts", () => ({
  listUnextractedSessions: mocks.listUnextractedSessions,
  getUnextracted: mocks.getUnextracted,
  markExtracted: mocks.markExtracted,
  upsertNode: mocks.upsertNode,
  upsertEdge: mocks.upsertEdge,
  findByName: mocks.findByName,
  getBySession: mocks.getBySession,
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
    setEmbedBatchFn(): void {}
    async syncEmbed(): Promise<void> {}
    async syncEmbedBatch(): Promise<void> {}
  },
}));

vi.mock("../src/extractor/extract.ts", () => ({
  Extractor: class {
    async extract() {
      return mocks.extract();
    }
  },
}));

import { isAffirmative, runBackfillExtraction } from "../src/cli-extract.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

function makeCfg(overrides: Record<string, unknown> = {}) {
  return {
    ...DEFAULT_CONFIG,
    neo4j: { uri: "bolt://localhost:7687", user: "neo4j", password: "x" },
    llm: { provider: "openai", apiKey: "k", baseURL: "https://api.openai.com/v1", model: "gpt-test" },
    ...overrides,
  } as any;
}

const SAMPLE_SESSION = {
  sessionId: "sid-abc-1234567890",
  messageCount: 5,
  maxTurn: 5,
  minCreatedAt: 1700000000000,
};

describe("isAffirmative", () => {
  it.each([
    ["y", true],
    ["Y", true],
    ["yes", true],
    ["YES", true],
    ["  yes  ", true],
    ["yeah", true],
    ["ok", true],
    ["confirm", true],
    ["1", true],
    ["true", true],
    ["n", false],
    ["no", false],
    ["", false],
    ["maybe", false],
    ["nope", false],
    ["0", false],
  ])("isAffirmative(%j) -> %s", (input, expected) => {
    expect(isAffirmative(input)).toBe(expected);
  });
});

describe("runBackfillExtraction", () => {
  beforeEach(() => {
    mocks.listUnextractedSessions.mockReset();
    mocks.getUnextracted.mockReset();
    mocks.markExtracted.mockReset();
    mocks.upsertNode.mockReset();
    mocks.upsertEdge.mockReset();
    mocks.findByName.mockReset();
    mocks.getBySession.mockReset();
    mocks.extract.mockReset();
    mocks.initSchema.mockReset();
    mocks.closeDriver.mockReset();

    mocks.initSchema.mockResolvedValue(undefined);
    mocks.closeDriver.mockResolvedValue(undefined);
    mocks.getBySession.mockResolvedValue([]);
    mocks.extract.mockResolvedValue({ nodes: [], edges: [] });
    mocks.upsertNode.mockImplementation(async (_d: any, c: any) => ({
      node: {
        id: `n-${c.name}`,
        type: c.type,
        name: c.name,
        description: c.description ?? "",
        content: c.content,
        status: "active",
        validatedCount: 1,
        sourceSessions: [],
        communityId: null,
        pagerank: 0,
        createdAt: 0,
        updatedAt: 0,
      },
      isNew: true,
    }));
    mocks.upsertEdge.mockResolvedValue(undefined);
    mocks.findByName.mockResolvedValue(null);
    mocks.markExtracted.mockResolvedValue(undefined);
  });

  it("returns sessionsTotal=0 and skips everything when no unextracted sessions", async () => {
    mocks.listUnextractedSessions.mockResolvedValue([]);
    const log = vi.fn();

    const result = await runBackfillExtraction({
      cfg: makeCfg(),
      effectiveModel: "gpt-test",
      options: {},
      log,
    });

    expect(result.sessionsTotal).toBe(0);
    expect(result.sessionsProcessed).toBe(0);
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.closeDriver).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("没有需要提取的会话"));
  });

  it("requires an LLM model and throws a clear error when missing", async () => {
    mocks.listUnextractedSessions.mockResolvedValue([]);
    await expect(
      runBackfillExtraction({ cfg: makeCfg(), effectiveModel: "", options: {}, log: vi.fn() }),
    ).rejects.toThrow(/LLM model/);
    expect(mocks.closeDriver).not.toHaveBeenCalled();
  });

  it("requires neo4j.uri and throws a clear error when missing", async () => {
    mocks.listUnextractedSessions.mockResolvedValue([]);
    await expect(
      runBackfillExtraction({
        cfg: { ...makeCfg(), neo4j: { uri: "", user: "", password: "" } } as any,
        effectiveModel: "gpt-test",
        options: {},
        log: vi.fn(),
      }),
    ).rejects.toThrow(/neo4j\.uri/);
  });

  it("aborts when the user declines the confirmation prompt", async () => {
    mocks.listUnextractedSessions.mockResolvedValue([SAMPLE_SESSION]);
    const prompt = vi.fn().mockResolvedValue("n");
    const log = vi.fn();

    const result = await runBackfillExtraction({
      cfg: makeCfg(),
      effectiveModel: "gpt-test",
      options: {},
      log,
      prompt,
    });

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(result.sessionsProcessed).toBe(0);
    expect(result.sessionsSkipped).toBe(1);
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.markExtracted).not.toHaveBeenCalled();
    expect(mocks.closeDriver).toHaveBeenCalledTimes(1);
  });

  it("does not prompt when --yes is set and runs extraction", async () => {
    mocks.listUnextractedSessions.mockResolvedValue([SAMPLE_SESSION]);
    mocks.getUnextracted.mockResolvedValueOnce([
      { role: "user", content: "hello", turn_index: 1 },
      { role: "assistant", content: "hi", turn_index: 2 },
    ]).mockResolvedValueOnce([]);
    mocks.extract.mockResolvedValueOnce({
      nodes: [
        { type: "TASK", name: "t1", description: "d", content: "c" },
        { type: "SKILL", name: "s1", description: "d", content: "c" },
      ],
      edges: [
        { from: "t1", to: "s1", type: "USED_SKILL", instruction: "i" },
      ],
    });
    const prompt = vi.fn();
    const log = vi.fn();

    const result = await runBackfillExtraction({
      cfg: makeCfg(),
      effectiveModel: "gpt-test",
      options: { yes: true },
      log,
      prompt,
    });

    expect(prompt).not.toHaveBeenCalled();
    expect(result.sessionsProcessed).toBe(1);
    expect(result.nodesCreated).toBe(2);
    expect(result.edgesCreated).toBe(1);
    expect(result.batches).toBe(1);
    expect(mocks.extract).toHaveBeenCalledTimes(1);
    // 提取产出 2 节点 → producedKnowledge=true（空提取时应为 false，证据保留）
    expect(mocks.markExtracted).toHaveBeenCalledWith(expect.anything(), "sid-abc-1234567890", 2, true);
    expect(mocks.closeDriver).toHaveBeenCalledTimes(1);
  });

  it("marks empty extractions as producedKnowledge=false (evidence retained)", async () => {
    mocks.listUnextractedSessions.mockResolvedValue([SAMPLE_SESSION]);
    mocks.getUnextracted.mockResolvedValueOnce([
      { role: "user", content: "hello", turn_index: 1 },
    ]).mockResolvedValueOnce([]);
    mocks.extract.mockResolvedValueOnce({ nodes: [], edges: [] });
    const log = vi.fn();

    const result = await runBackfillExtraction({
      cfg: makeCfg(),
      effectiveModel: "gpt-test",
      options: { yes: true },
      log,
      prompt: vi.fn(),
    });

    expect(result.sessionsProcessed).toBe(1);
    expect(result.nodesCreated).toBe(0);
    expect(mocks.markExtracted).toHaveBeenCalledWith(expect.anything(), "sid-abc-1234567890", 1, false);
  });

  it("filters sessions to the one specified by --session", async () => {
    mocks.listUnextractedSessions.mockResolvedValue([
      { ...SAMPLE_SESSION, sessionId: "aaa" },
      { ...SAMPLE_SESSION, sessionId: "bbb" },
    ]);
    mocks.getUnextracted.mockResolvedValue([]);
    const log = vi.fn();

    const result = await runBackfillExtraction({
      cfg: makeCfg(),
      effectiveModel: "gpt-test",
      options: { yes: true, session: "bbb" },
      log,
    });

    expect(result.sessionsTotal).toBe(1);
    expect(result.sessionsProcessed).toBe(1);
    expect(mocks.getUnextracted).toHaveBeenCalledWith(expect.anything(), "bbb", expect.any(Number));
  });

  it("exits cleanly when --session matches no sessions", async () => {
    mocks.listUnextractedSessions.mockResolvedValue([SAMPLE_SESSION]);
    const log = vi.fn();

    const result = await runBackfillExtraction({
      cfg: makeCfg(),
      effectiveModel: "gpt-test",
      options: { session: "does-not-exist" },
      log,
    });

    expect(result.sessionsTotal).toBe(0);
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.closeDriver).toHaveBeenCalledTimes(1);
  });

  it("lists sessions but does not extract under --dry-run", async () => {
    mocks.listUnextractedSessions.mockResolvedValue([SAMPLE_SESSION]);
    const prompt = vi.fn();
    const log = vi.fn();

    const result = await runBackfillExtraction({
      cfg: makeCfg(),
      effectiveModel: "gpt-test",
      options: { dryRun: true },
      log,
      prompt,
    });

    expect(prompt).not.toHaveBeenCalled();
    expect(result.sessionsSkipped).toBe(1);
    expect(result.sessionsProcessed).toBe(0);
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("--dry-run"));
    expect(mocks.closeDriver).toHaveBeenCalledTimes(1);
  });

  it("loops multiple batches until getUnextracted returns empty", async () => {
    mocks.listUnextractedSessions.mockResolvedValue([SAMPLE_SESSION]);
    mocks.getUnextracted
      .mockResolvedValueOnce([
        { role: "user", content: "m1", turn_index: 1 },
      ])
      .mockResolvedValueOnce([
        { role: "user", content: "m2", turn_index: 2 },
      ])
      .mockResolvedValueOnce([]);
    mocks.extract.mockResolvedValue({ nodes: [], edges: [] });
    const log = vi.fn();

    const result = await runBackfillExtraction({
      cfg: makeCfg(),
      effectiveModel: "gpt-test",
      options: { yes: true, limit: 1 },
      log,
    });

    expect(result.batches).toBe(2);
    expect(mocks.markExtracted).toHaveBeenCalledTimes(2);
    expect(mocks.closeDriver).toHaveBeenCalledTimes(1);
  });

  it("records a session as skipped when getUnextracted throws", async () => {
    mocks.listUnextractedSessions.mockResolvedValue([
      { ...SAMPLE_SESSION, sessionId: "good" },
      { ...SAMPLE_SESSION, sessionId: "bad" },
    ]);
    const callCount = new Map<string, number>();
    mocks.getUnextracted.mockImplementation(async (_d: any, sid: string) => {
      if (sid === "bad") throw new Error("boom");
      const n = (callCount.get(sid) ?? 0) + 1;
      callCount.set(sid, n);
      if (n === 1) return [{ role: "user", content: "x", turn_index: 1 }];
      return [];
    });
    mocks.extract.mockResolvedValue({ nodes: [], edges: [] });
    const log = vi.fn();

    const result = await runBackfillExtraction({
      cfg: makeCfg(),
      effectiveModel: "gpt-test",
      options: { yes: true },
      log,
    });

    expect(result.sessionsProcessed).toBe(1);
    expect(result.sessionsSkipped).toBe(1);
    expect(result.sessionsTotal).toBe(2);
    expect(mocks.closeDriver).toHaveBeenCalledTimes(1);
  });

  it("calls closeDriver even when listUnextractedSessions throws (try/finally)", async () => {
    mocks.listUnextractedSessions.mockRejectedValue(new Error("neo4j down"));
    const log = vi.fn();

    await expect(
      runBackfillExtraction({
        cfg: makeCfg(),
        effectiveModel: "gpt-test",
        options: { yes: true },
        log,
      }),
    ).rejects.toThrow("neo4j down");

    expect(mocks.closeDriver).toHaveBeenCalledTimes(1);
  });

  it("does not warn about batch ceiling when session completes before the ceiling", async () => {
    mocks.listUnextractedSessions.mockResolvedValue([SAMPLE_SESSION]);
    const fullBatches = 3;
    mocks.getUnextracted.mockImplementation(async () => {
      const call = mocks.getUnextracted.mock.calls.length;
      if (call < fullBatches) return Array.from({ length: 5 }, (_, i) => ({ role: "user", content: `m${i}`, turn_index: call * 5 + i }));
      return [{ role: "user", content: "last", turn_index: fullBatches * 5 }];
    });
    mocks.extract.mockResolvedValue({ nodes: [], edges: [] });
    const log = vi.fn();

    const result = await runBackfillExtraction({
      cfg: makeCfg({ compactTurnCount: 1 }),
      effectiveModel: "gpt-test",
      options: { yes: true, limit: 5 },
      log,
    });

    expect(result.batches).toBe(fullBatches);
    expect(result.sessionsProcessed).toBe(1);
    const warningCalls = log.mock.calls.filter(c => typeof c[0] === "string" && c[0].includes("达到批数上限"));
    expect(warningCalls).toHaveLength(0);
  });

  it("warns about batch ceiling when the session genuinely has more messages than the ceiling allows", async () => {
    mocks.listUnextractedSessions.mockResolvedValue([SAMPLE_SESSION]);
    mocks.getUnextracted.mockResolvedValue(Array.from({ length: 5 }, (_, i) => ({ role: "user", content: `m${i}`, turn_index: i })));
    mocks.extract.mockResolvedValue({ nodes: [], edges: [] });
    const log = vi.fn();

    const result = await runBackfillExtraction({
      cfg: makeCfg({ compactTurnCount: 1 }),
      effectiveModel: "gpt-test",
      options: { yes: true, limit: 5 },
      log,
    });

    expect(result.batches).toBe(50);
    const warningCalls = log.mock.calls.filter(c => typeof c[0] === "string" && c[0].includes("达到批数上限"));
    expect(warningCalls).toHaveLength(1);
  });
});
