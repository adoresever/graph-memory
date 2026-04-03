import { describe, expect, it } from "vitest";

import { LlmFailureGuard } from "../src/engine/llm-guard.ts";

describe("LlmFailureGuard", () => {
  it("pauses after permanent 4xx API errors", () => {
    let now = 1_000;
    const guard = new LlmFailureGuard(60_000, () => now);

    expect(guard.canRun()).toBe(true);
    expect(
      guard.tripIfNeeded(new Error('[graph-memory] LLM API 403: {"error":"User not found or inactive"}')),
    ).toBe(true);
    expect(guard.canRun()).toBe(false);

    now += 59_000;
    expect(guard.canRun()).toBe(false);

    now += 2_000;
    expect(guard.canRun()).toBe(true);
  });

  it("ignores retryable errors", () => {
    const guard = new LlmFailureGuard(60_000, () => 1_000);

    expect(guard.tripIfNeeded(new Error("[graph-memory] LLM API 429: rate limited"))).toBe(false);
    expect(guard.canRun()).toBe(true);
  });
});
