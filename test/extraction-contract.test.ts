import { describe, expect, it } from "vitest";
import { assertGraphExtractionContract } from "../src/extractor/contract.ts";

const validPayload = {
  turn: {
    summary: "本轮确认当前发布状态。",
    outcome: "informational",
    sourceTurns: [1],
  },
  nodes: [{
    type: "EVENT",
    name: "current-release-state",
    description: "当前发布状态",
    content: "发布状态由本轮回答确认",
    operation: "create",
    temporal: {},
    sourceTurns: [1],
  }],
  edges: [],
  invalidations: [],
};

describe("graph extraction data contract", () => {
  it("accepts a complete payload without interpreting its content", () => {
    expect(() => assertGraphExtractionContract(validPayload)).not.toThrow();
  });

  it("accepts non-empty model-authored concept names without style policing", () => {
    const payload = {
      ...validPayload,
      nodes: [{ ...validPayload.nodes[0], name: "ReleaseOrchestrator.updateConfig()" }],
    };
    expect(() => assertGraphExtractionContract(payload)).not.toThrow();
  });

  it("rejects a payload with a missing required field", () => {
    const { invalidations: _removed, ...incomplete } = validPayload;
    expect(() => assertGraphExtractionContract(incomplete)).toThrow("contract violation");
  });

  it("rejects undeclared fields instead of silently rewriting them", () => {
    expect(() => assertGraphExtractionContract({ ...validPayload, extra: true })).toThrow("contract violation");
  });
});
