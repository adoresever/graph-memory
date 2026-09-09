import { describe, expect, it } from "vitest";

import {
  projectDshCompletedTurnMemory,
  replaceDshCompletedTurnTrace,
  selectDshCompletedTurnTraceRange,
} from "../src/format/dsh-turn-projection.ts";

function textAssistant(turn: number, text: string) {
  return { type: "assistant/message", data: { turn, message: { content: [{ type: "text", text }] } } };
}

describe("DSH completed-turn surface projection", () => {
  it("projects exact visible question and final answer without reasoning or tools", () => {
    const events: any[] = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "question" }] } },
      { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "reasoning", text: "hidden" }, { type: "tool-call" }] } } },
      { type: "tool/result", data: { turn: 1, message: { content: [{ type: "text", text: "tool output" }] } } },
      { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "reasoning", text: "hidden final" }, { type: "text", text: "answer" }] } } },
      { type: "turn/end", data: { turn: 1 } },
    ];
    expect(projectDshCompletedTurnMemory({ events }, 1, 5)).toEqual({
      turn: 1,
      questionSeq: 1,
      finalAnswerSeq: 4,
      userQuestion: "question",
      finalAnswer: "answer",
    });
  });

  it("keeps the native question and final answer while selecting the middle tool trace", () => {
    const events: any[] = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { source: { kind: "plugin" } } },
      { type: "user/message", data: { source: { kind: "user" } } },
      { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "tool-call" }] } } },
      { type: "tool/result", data: { turn: 1 } },
      textAssistant(1, "done"),
      { type: "turn/end", data: { turn: 1 } },
    ];
    const range = selectDshCompletedTurnTraceRange(
      { events, surface: { nodes: [1, 2, 3, 4, 5] } },
      1,
      6,
    );
    expect(range).toEqual({
      turn: 1,
      start: 3,
      end: 4,
      shadowedSeqs: [3, 4],
      questionSeq: 2,
      finalAnswerSeq: 5,
    });
  });

  it("does not project a simple question-answer turn", () => {
    const events: any[] = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { source: { kind: "user" } } },
      textAssistant(1, "done"),
      { type: "turn/end", data: { turn: 1 } },
    ];
    expect(selectDshCompletedTurnTraceRange(
      { events, surface: { nodes: [1, 2] } },
      1,
      3,
    )).toBeNull();
  });

  it("does not project a turn without a final visible assistant answer", () => {
    const events: any[] = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { source: { kind: "user" } } },
      { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "tool-call" }] } } },
      { type: "tool/result", data: { turn: 1 } },
      { type: "turn/end", data: { turn: 1 } },
    ];
    expect(selectDshCompletedTurnTraceRange(
      { events, surface: { nodes: [1, 2, 3] } },
      1,
      4,
    )).toBeNull();
  });

  it("writes a priced replacement with complete provenance", () => {
    const appended: any[] = [];
    const session = {
      id: "s1",
      append(type: string, data: unknown, options?: unknown) {
        const event = { seq: 10 + appended.length, type, data, options };
        appended.push(event);
        return event;
      },
    };
    const result = replaceDshCompletedTurnTrace(session, {
      measure: () => ({ nodes: [{ seq: 3, heuristicTokens: 120 }, { seq: 4, heuristicTokens: 80 }] }),
    }, {
      turn: 1,
      start: 3,
      end: 4,
      shadowedSeqs: [3, 4],
      questionSeq: 2,
      finalAnswerSeq: 5,
    });
    expect(result.shadowedTokenCount).toBe(200);
    expect(appended[1].options).toEqual({
      surfaceOp: { op: "replace", startSeq: 3, endSeq: 4 },
      sourceEventSeqs: [10, 3, 4],
    });
  });
});
