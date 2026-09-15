import { describe, expect, it } from "vitest";

import { extractLlmStatus, LlmFailureGuard } from "../src/engine/llm-guard.ts";

describe("LlmFailureGuard", () => {
  it("pauses after permanent 4xx API errors and recovers after cooldown", () => {
    let now = 1_000;
    const guard = new LlmFailureGuard(60_000, () => now);

    expect(guard.canRun()).toBe(true);
    expect(
      guard.tripIfNeeded(new Error('[graph-memory] LLM API 403: {"error":"User not found or inactive"}')),
    ).toBe(true);
    expect(guard.canRun()).toBe(false);
    expect(guard.remainingMs()).toBe(60_000);

    now += 59_000;
    expect(guard.canRun()).toBe(false);

    now += 2_000;
    expect(guard.canRun()).toBe(true);
  });

  it("ignores retryable errors (fetchRetry already retried them)", () => {
    const guard = new LlmFailureGuard(60_000, () => 1_000);

    expect(guard.tripIfNeeded(new Error("[graph-memory] LLM API 429: rate limited"))).toBe(false);
    expect(guard.tripIfNeeded(new Error("[graph-memory] LLM API 503: upstream down"))).toBe(false);
    expect(guard.canRun()).toBe(true);
  });

  it("does not pause for request-specific 400 and 422 errors", () => {
    const guard = new LlmFailureGuard(60_000, () => 1_000);

    expect(guard.tripIfNeeded(new Error("[graph-memory] LLM API 400: prompt too long"))).toBe(false);
    expect(guard.tripIfNeeded(new Error("[graph-memory] LLM API 422: invalid message"))).toBe(false);
    expect(guard.canRun()).toBe(true);
  });

  it("does not pause for errors without an HTTP status (timeout, empty content, config)", () => {
    const guard = new LlmFailureGuard(60_000, () => 1_000);

    expect(guard.tripIfNeeded(new Error("[graph-memory] LLM request timed out after 60000ms"))).toBe(false);
    expect(guard.tripIfNeeded(new Error("[graph-memory] LLM returned empty content"))).toBe(false);
    expect(guard.tripIfNeeded(new Error("[graph-memory] llm.provider=anthropic 但未配 llm.apiKey"))).toBe(false);
    expect(guard.canRun()).toBe(true);
  });

  it("recognizes all three provider error formats (openai / anthropic / oauth)", () => {
    expect(extractLlmStatus(new Error("[graph-memory] LLM API 401: invalid key"))).toBe(401);
    expect(extractLlmStatus(new Error("[graph-memory] Anthropic API 403: forbidden"))).toBe(403);
    expect(extractLlmStatus(new Error("[graph-memory] OAuth LLM API 404: model not found"))).toBe(404);
  });

  it("pauses when the OAuth refresh token is rejected (persistent credential failure)", () => {
    // token 端点的 400 = invalid_grant（refresh token 被吊销/过期）—— 持久性故障
    const guard = new LlmFailureGuard(60_000, () => 1_000);
    expect(guard.tripIfNeeded(new Error("OAuth refresh failed (400): invalid_grant"))).toBe(true);
    expect(guard.tripIfNeeded(new Error("OAuth refresh failed (401): unauthorized"))).toBe(true);
    expect(guard.canRun()).toBe(false);
  });

  it("does not pause for transient OAuth refresh failures", () => {
    const guard = new LlmFailureGuard(60_000, () => 1_000);
    expect(guard.tripIfNeeded(new Error("OAuth refresh failed (429): slow down"))).toBe(false);
    expect(guard.tripIfNeeded(new Error("OAuth refresh failed (500): upstream error"))).toBe(false);
    expect(guard.tripIfNeeded(new Error("OAuth refresh returned no access token"))).toBe(false);
    expect(guard.tripIfNeeded(new Error("OAuth session from /x is expired and has no refresh token"))).toBe(false);
    expect(guard.canRun()).toBe(true);
  });

  it("pauses Anthropic authentication failures", () => {
    const guard = new LlmFailureGuard(60_000, () => 1_000);

    expect(guard.tripIfNeeded(new Error("[graph-memory] Anthropic API 401: invalid x-api-key"))).toBe(true);
    expect(guard.canRun()).toBe(false);
  });

  it("repeated trips extend the pause instead of shortening it", () => {
    let now = 1_000;
    const guard = new LlmFailureGuard(60_000, () => now);

    guard.tripIfNeeded(new Error("[graph-memory] LLM API 401: expired"));
    now += 30_000;
    guard.tripIfNeeded(new Error("[graph-memory] LLM API 403: revoked"));
    expect(guard.remainingMs()).toBe(60_000);
  });

  it("reset() clears the pause after a successful call", () => {
    const guard = new LlmFailureGuard(60_000, () => 1_000);

    guard.tripIfNeeded(new Error("[graph-memory] LLM API 401: expired"));
    expect(guard.canRun()).toBe(false);
    guard.reset();
    expect(guard.canRun()).toBe(true);
  });
});
