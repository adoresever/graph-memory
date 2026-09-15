import { afterEach, describe, expect, it, vi } from "vitest";

import { Neo4jGate } from "../src/store/gate.ts";

describe("Neo4j 熔断门控 (Neo4jGate)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closed 状态放行所有操作，成功复位失败计数", () => {
    const gate = new Neo4jGate(2, 120_000);
    expect(gate.isAvailable()).toBe(true);

    gate.recordFailure();
    expect(gate.isAvailable()).toBe(true);

    gate.recordSuccess();
    gate.recordFailure();
    expect(gate.isAvailable()).toBe(true);
  });

  it("连续失败达到阈值后跳闸，冷却期内不可用", () => {
    vi.useFakeTimers();
    const gate = new Neo4jGate(2, 120_000);

    gate.recordFailure();
    gate.recordFailure();
    expect(gate.isAvailable()).toBe(false);

    vi.advanceTimersByTime(119_999);
    expect(gate.isAvailable()).toBe(false);

    vi.advanceTimersByTime(1);
    expect(gate.isAvailable()).toBe(true);
  });

  it("半开后一次成功即完全恢复（计数归零）", () => {
    vi.useFakeTimers();
    const gate = new Neo4jGate(2, 120_000);

    gate.recordFailure();
    gate.recordFailure();
    vi.advanceTimersByTime(120_000);
    expect(gate.isAvailable()).toBe(true);

    gate.recordSuccess();
    gate.recordFailure();
    expect(gate.isAvailable()).toBe(true);
  });

  it("半开探测失败重新进入冷却", () => {
    vi.useFakeTimers();
    const gate = new Neo4jGate(2, 120_000);

    gate.recordFailure();
    gate.recordFailure();
    vi.advanceTimersByTime(120_000);

    gate.recordFailure();
    expect(gate.isAvailable()).toBe(false);

    vi.advanceTimersByTime(119_999);
    expect(gate.isAvailable()).toBe(false);

    vi.advanceTimersByTime(1);
    expect(gate.isAvailable()).toBe(true);
  });
});
