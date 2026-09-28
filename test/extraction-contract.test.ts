import { describe, expect, it } from "vitest";
import { assertGraphExtractionContract, GRAPH_EXTRACTION_TOOL } from "../src/extractor/contract.ts";

const validPayload = {
  summary: "本轮确认当前发布状态。",
  outcome: "informational",
  triples: [{
    subject: "当前版本",
    predicate: "状态为",
    object: "已发布",
  }],
};

describe("graph extraction data contract", () => {
  it("keeps the provider-visible tool neutral to the host implementation", () => {
    expect(GRAPH_EXTRACTION_TOOL.name).toBe("submit_result");
    const visible = JSON.stringify(GRAPH_EXTRACTION_TOOL).toLowerCase();
    expect(visible).not.toContain("graph memory");
    expect(visible).not.toContain("navigation");
  });

  it("accepts a complete payload without interpreting its content", () => {
    expect(() => assertGraphExtractionContract(validPayload)).not.toThrow();
  });

  it("accepts non-empty model-authored triple values without style policing", () => {
    const payload = {
      ...validPayload,
      triples: [{ ...validPayload.triples[0], subject: "ReleaseOrchestrator.updateConfig()" }],
    };
    expect(() => assertGraphExtractionContract(payload)).not.toThrow();
  });

  it("rejects a payload with a missing required field", () => {
    const { triples: _removed, ...incomplete } = validPayload;
    expect(() => assertGraphExtractionContract(incomplete)).toThrow("contract violation");
  });

  it("rejects undeclared fields instead of silently rewriting them", () => {
    expect(() => assertGraphExtractionContract({ ...validPayload, extra: true })).toThrow("contract violation");
  });
});
