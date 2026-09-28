import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { TurnOutcome } from "../types.ts";

const OutcomeSchema = Type.String({
  enum: ["completed", "partial", "failed", "informational", "unknown"],
  description: "Required final status of this completed dialogue turn.",
});

const NavigationTripleSchema = Type.Object({
  subject: Type.String({ minLength: 1, description: "Concrete searchable subject phrase." }),
  predicate: Type.String({ minLength: 1, description: "Short relation phrase." }),
  object: Type.String({ minLength: 1, description: "Concrete searchable object phrase." }),
}, { additionalProperties: false });

/**
 * Provider-facing extraction contract.
 *
 * Keep every required value at the top level. DSH's public ToolSchema does
 * not currently expose pi-ai constrained sampling, so custom OpenAI-compatible
 * routes receive an advisory schema. A flat shape and a single JSON `enum`
 * are followed more reliably across providers than nested required objects and
 * an `anyOf` of literals, while the runtime still validates every field.
 */
export const GRAPH_EXTRACTION_SCHEMA = Type.Object({
  summary: Type.String({
    minLength: 1,
    description: "Required one-sentence, self-contained summary of the current dialogue turn.",
  }),
  outcome: OutcomeSchema,
  triples: Type.Array(NavigationTripleSchema, {
    description: "Required SPO relations derived only from summary; use an empty array when none are explicit.",
  }),
}, { additionalProperties: false });

export interface StructuredGraphExtraction {
  summary: string;
  outcome: TurnOutcome;
  triples: Array<{ subject: string; predicate: string; object: string }>;
}

export const GRAPH_EXTRACTION_TOOL_NAME = "submit_result";

export const GRAPH_EXTRACTION_TOOL = Object.freeze({
  name: GRAPH_EXTRACTION_TOOL_NAME,
  description: "Submit exactly the three required fields summary, outcome, and triples. Derive zero or more subject-predicate-object triples only from the summary; triples must be [] when no relation is explicit. Emit no text.",
  parameters: GRAPH_EXTRACTION_SCHEMA,
});

/** Fail closed before normalization or persistence when the contract is incomplete. */
export function assertGraphExtractionContract(value: unknown): asserts value is StructuredGraphExtraction {
  if (Value.Check(GRAPH_EXTRACTION_SCHEMA, value)) return;
  const errors = Array.from(Value.Errors(GRAPH_EXTRACTION_SCHEMA, value))
    .slice(0, 3)
    .map(error => `${error.path || "/"}: ${error.message}`)
    .join("; ");
  throw new TypeError(`graph extraction contract violation${errors ? `: ${errors}` : ""}`);
}
