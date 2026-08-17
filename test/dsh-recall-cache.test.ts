/**
 * graph-memory — DSH recallCache 回归测试
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 *
 * 覆盖 dsh.ts 的 system-prompt/assemble 召回缓存：一次失败的召回必须被
 * 从 recallCache 驱逐，否则同一 rejected Promise 会被钉在缓存里，之后每轮
 * assemble 都 re-await 它，把单次瞬时错误变成每轮必现的重复报错。
 */

import { describe, expect, it, vi } from "vitest";

const { recallMock } = vi.hoisted(() => ({ recallMock: vi.fn() }));

vi.mock("../src/recaller/recall.ts", () => {
  class MockRecaller {
    static instances: MockRecaller[] = [];
    recall = recallMock;
    setEmbedFn = vi.fn();
    syncEmbed = vi.fn();
    constructor(_db: unknown, _cfg: unknown) {
      MockRecaller.instances.push(this);
    }
  }
  return { Recaller: MockRecaller };
});

import { apply } from "../dsh.ts";

interface Handler {
  (...args: any[]): any;
}

function mockCtx() {
  const handlers = new Map<string, Handler>();
  const disposers: Array<() => void | Promise<void>> = [];
  return {
    handlers,
    disposers,
    ctx: {
      logger: { info() {}, warn() {}, error() {} },
      llm: {
        stream() {
          throw new Error("llm.stream should not be used in this test");
        },
      },
      tools: { register() { return () => {}; } },
      credentials: {
        async resolve() { return undefined; },
      },
      on(event: string, listener: Handler) {
        handlers.set(event, listener);
        return () => {};
      },
      effect(register: () => () => void | Promise<void>) {
        const disposer = register();
        disposers.push(disposer);
        return () => {};
      },
    },
  };
}

async function dispose(harness: { disposers: Array<() => void | Promise<void>> }): Promise<void> {
  for (const disposer of harness.disposers) await disposer();
}

describe("DSH recall cache", () => {
  beforeEach(() => {
    recallMock.mockReset();
  });

  it("evicts a failed recall so the next assembly retries instead of re-awaiting the rejected promise", async () => {
    recallMock
      .mockRejectedValueOnce(new Error("transient: database is locked"))
      .mockResolvedValue({ nodes: [], edges: [] });

    const harness = mockCtx();
    const { ctx, handlers } = harness;
    apply(ctx, { dbPath: ":memory:", extractionEnabled: false });
    try {
      const claimed = handlers.get("agent/inbox/claimed")!;
      const assemble = handlers.get("system-prompt/assemble")!;

      claimed({ agent: { id: "agent-1" }, message: { source: { kind: "user" }, content: "remember anything about sqlite?" } });

      const assembly = { contexts: [] as any[] };
      await assemble(assembly, { agent: { id: "agent-1" } }, async () => {});
      // First attempt failed (recall rejected).
      expect(recallMock).toHaveBeenCalledTimes(1);

      await assemble(assembly, { agent: { id: "agent-1" } }, async () => {});
      // Regression: without eviction the second assembly re-awaits the pinned
      // rejected Promise (still 1 call) and fails again. With eviction it must
      // run a fresh recall.
      expect(recallMock).toHaveBeenCalledTimes(2);
    } finally {
      await dispose(harness);
    }
  });

  it("keeps caching a successful recall for the same agent and query", async () => {
    recallMock.mockResolvedValue({ nodes: [], edges: [] });

    const harness = mockCtx();
    const { ctx, handlers } = harness;
    apply(ctx, { dbPath: ":memory:", extractionEnabled: false });
    try {
      const claimed = handlers.get("agent/inbox/claimed")!;
      const assemble = handlers.get("system-prompt/assemble")!;

      claimed({ agent: { id: "agent-2" }, message: { source: { kind: "user" }, content: "what do I know about pagerank?" } });

      const assembly = { contexts: [] as any[] };
      await assemble(assembly, { agent: { id: "agent-2" } }, async () => {});
      await assemble(assembly, { agent: { id: "agent-2" } }, async () => {});
      await assemble(assembly, { agent: { id: "agent-2" } }, async () => {});

      // Success must stay cached: repeated assemblies reuse the same recall.
      expect(recallMock).toHaveBeenCalledTimes(1);
    } finally {
      await dispose(harness);
    }
  });
});
