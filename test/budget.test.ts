/**
 * graph-memory — LLM call budget tests
 */

import { describe, it, expect } from "vitest";
import { createTestDb } from "./helpers.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import { reserveLlmCall } from "../src/engine/budget.ts";

describe("monthly dynamic LLM call budget", () => {
  it("allows calls until today's dynamic allowance is exhausted", () => {
    const db = createTestDb();
    const cfg = {
      ...DEFAULT_CONFIG,
      llmMonthlyCallBudget: 1,
      llmMonthlyCommunitySummaryBudget: 0,
      llmMonthlyFinalizeBudget: 0,
    };

    expect(reserveLlmCall(db, cfg, "extract").allowed).toBe(true);

    const second = reserveLlmCall(db, cfg, "extract");
    expect(second.allowed).toBe(false);
    expect(second.reason).toContain("budget exhausted");
  });

  it("enforces community summary dynamic allowance without consuming skipped calls", () => {
    const db = createTestDb();
    const cfg = {
      ...DEFAULT_CONFIG,
      llmMonthlyCallBudget: 10_000,
      llmMonthlyCommunitySummaryBudget: 1,
      llmMonthlyFinalizeBudget: 0,
    };

    expect(reserveLlmCall(db, cfg, "community_summary").allowed).toBe(true);

    const skipped = reserveLlmCall(db, cfg, "community_summary");
    expect(skipped.allowed).toBe(false);
    expect(skipped.reason).toContain("community_summary");

    const extract = reserveLlmCall(db, cfg, "extract");
    expect(extract.allowed).toBe(true);
    expect(extract.monthUsed).toBe(2);
  });

  it("zero budgets mean unlimited for that dimension", () => {
    const db = createTestDb();
    const cfg = {
      ...DEFAULT_CONFIG,
      llmMonthlyCallBudget: 0,
      llmMonthlyCommunitySummaryBudget: 0,
      llmMonthlyFinalizeBudget: 0,
    };

    for (let i = 0; i < 5; i++) {
      expect(reserveLlmCall(db, cfg, "community_summary").allowed).toBe(true);
    }
  });

  it("unused monthly calls raise the dynamic daily allowance later in the month", () => {
    const db = createTestDb();
    const cfg = {
      ...DEFAULT_CONFIG,
      llmMonthlyCallBudget: 90_000,
      llmMonthlyCommunitySummaryBudget: 0,
      llmMonthlyFinalizeBudget: 0,
    };

    const reservation = reserveLlmCall(db, cfg, "extract");
    expect(reservation.allowed).toBe(true);
    expect(reservation.todayLimit).toBeGreaterThan(0);
    expect(reservation.todayLimit).toBeLessThanOrEqual(90_000);
  });
});
