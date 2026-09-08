import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const NodeTemporalSchema = Type.Object({
  eventTime: Type.Optional(Type.String()),
  validFrom: Type.Optional(Type.String()),
  validUntil: Type.Optional(Type.String()),
  state: Type.Optional(Type.Union([
    Type.Literal("current"),
    Type.Literal("historical"),
    Type.Literal("uncertain"),
    Type.Literal("superseded"),
  ])),
}, { additionalProperties: false });

const ExtractionNodeSchema = Type.Object({
  type: Type.Union([Type.Literal("TASK"), Type.Literal("SKILL"), Type.Literal("EVENT")]),
  name: Type.String({ minLength: 1 }),
  description: Type.String(),
  content: Type.String({ minLength: 1 }),
  operation: Type.Union([Type.Literal("create"), Type.Literal("confirm"), Type.Literal("revise")]),
  temporal: NodeTemporalSchema,
  sourceTurns: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, uniqueItems: true }),
}, { additionalProperties: false });

const ExtractionEdgeSchema = Type.Object({
  from: Type.String({ minLength: 1 }),
  to: Type.String({ minLength: 1 }),
  type: Type.Union([
    Type.Literal("RELATES"),
    Type.Literal("SUPERSEDES"),
    Type.Literal("USED_SKILL"),
    Type.Literal("SOLVED_BY"),
    Type.Literal("REQUIRES"),
    Type.Literal("PATCHES"),
    Type.Literal("CONFLICTS_WITH"),
  ]),
  instruction: Type.String({ minLength: 1 }),
  condition: Type.Optional(Type.String()),
}, { additionalProperties: false });

const InvalidationSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  reason: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const TurnMemorySchema = Type.Object({
  summary: Type.String({ minLength: 1 }),
  outcome: Type.Union([
    Type.Literal("completed"),
    Type.Literal("partial"),
    Type.Literal("failed"),
    Type.Literal("informational"),
    Type.Literal("unknown"),
  ]),
  sourceTurns: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, uniqueItems: true }),
}, { additionalProperties: false });

/** Provider-facing and runtime-facing graph extraction contract. */
export const GRAPH_EXTRACTION_SCHEMA = Type.Object({
  turn: TurnMemorySchema,
  nodes: Type.Array(ExtractionNodeSchema),
  edges: Type.Array(ExtractionEdgeSchema),
  invalidations: Type.Array(InvalidationSchema),
}, { additionalProperties: false });

export type StructuredGraphExtraction = Static<typeof GRAPH_EXTRACTION_SCHEMA>;

export const GRAPH_EXTRACTION_TOOL_NAME = "submit_graph_extraction";

export const GRAPH_EXTRACTION_TOOL = Object.freeze({
  name: GRAPH_EXTRACTION_TOOL_NAME,
  description: "Submit one layered Graph Memory extraction: turn is the compact episodic summary, nodes and edges are its evidence-backed graph navigation. Each array item is the object itself. Match the parameter schema exactly and emit no text.",
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
