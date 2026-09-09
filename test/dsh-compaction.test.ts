import { describe, expect, it } from "vitest";

import {
  isDshUserTurn,
  selectDshRollingCompactionRange,
} from "../src/format/dsh-compaction.ts";

function user(kind = "user") {
  return { type: "user/message", data: { source: { kind } } };
}

describe("DSH rolling compaction selection", () => {
  it("counts only real user prompts and retains the configured tail", () => {
    const events = [
      user(),
      { type: "assistant/message" },
      user("plugin"),
      user(),
      { type: "tool/call" },
      { type: "tool/result" },
      user(),
      { type: "assistant/message" },
      user(),
    ];
    const range = selectDshRollingCompactionRange(
      { events, surface: { nodes: events.map((_, index) => index) } },
      3,
    );

    expect(range).toEqual({
      start: 0,
      end: 2,
      shadowedSeqs: [0, 1, 2],
      retainedUserTurns: 3,
    });
  });

  it("does nothing while the surface is within the configured turn count", () => {
    const events = [user(), { type: "assistant/message" }, user()];
    expect(selectDshRollingCompactionRange(
      { events, surface: { nodes: [0, 1, 2] } },
      2,
    )).toBeNull();
  });

  it("preserves DSH's protected system head while archiving old turns", () => {
    const events = [
      { type: "system/message" },
      user(), { type: "assistant/message" },
      user(), { type: "assistant/message" },
      user(), { type: "assistant/message" },
    ];
    expect(selectDshRollingCompactionRange(
      { events, surface: { nodes: events.map((_, index) => index) } },
      2,
    )).toEqual({
      start: 1,
      end: 2,
      shadowedSeqs: [1, 2],
      retainedUserTurns: 2,
    });
  });

  it("replaces an earlier archive marker together with the next expired turn", () => {
    const events = [
      { type: "system/message" },
      user("plugin"),
      user(), { type: "assistant/message" },
      user(), { type: "assistant/message" },
      user(), { type: "assistant/message" },
    ];
    expect(selectDshRollingCompactionRange(
      { events, surface: { nodes: events.map((_, index) => index) } },
      2,
    )).toEqual({
      start: 1,
      end: 3,
      shadowedSeqs: [1, 2, 3],
      retainedUserTurns: 2,
    });
  });

  it("counts a claimed incoming user turn before DSH appends it to the surface", () => {
    const events = [
      user(), { type: "assistant/message" },
      user(), { type: "assistant/message" },
      user(), { type: "assistant/message" },
      user(), { type: "assistant/message" },
      user(), { type: "assistant/message" },
    ];
    expect(selectDshRollingCompactionRange(
      { events, surface: { nodes: events.map((_, index) => index) } },
      5,
    )).toBeNull();
  });

  it("retains the current user plus the configured previous tail on tool continuations", () => {
    const events = [
      user(), { type: "assistant/message" },
      user(), { type: "assistant/message" },
      user(), { type: "assistant/message" },
      user(), { type: "assistant/message" },
    ];
    expect(selectDshRollingCompactionRange(
      { events, surface: { nodes: events.map((_, index) => index) } },
      2,
      true,
    )).toMatchObject({ start: 0, end: 1, shadowedSeqs: [0, 1] });
  });

  it("supports replacement seqs whose numeric order differs from surface order", () => {
    const events: any[] = [];
    events[20] = user("plugin");
    events[4] = user();
    events[5] = { type: "assistant/message" };
    events[9] = user();
    events[10] = { type: "assistant/message" };
    events[14] = user();

    expect(selectDshRollingCompactionRange(
      { events, surface: { nodes: [20, 4, 5, 9, 10, 14] } },
      2,
    )).toMatchObject({ start: 20, end: 5, shadowedSeqs: [20, 4, 5] });
  });

  it("rejects invalid retention instead of silently changing policy", () => {
    expect(() => selectDshRollingCompactionRange({}, 0)).toThrow(/positive integer/);
  });

  it("recognizes only durable user-origin prompts", () => {
    expect(isDshUserTurn(user())).toBe(true);
    expect(isDshUserTurn(user("plugin"))).toBe(false);
    expect(isDshUserTurn({ type: "assistant/message" })).toBe(false);
  });
});
