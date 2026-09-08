import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
const TurnMemorySchema = Type.Object({
    summary: Type.String({ minLength: 1 }),
    outcome: Type.Union([
        Type.Literal("completed"),
        Type.Literal("partial"),
        Type.Literal("failed"),
        Type.Literal("informational"),
        Type.Literal("unknown"),
    ]),
}, { additionalProperties: false });
const NavigationTripleSchema = Type.Object({
    subject: Type.String({ minLength: 1 }),
    predicate: Type.String({ minLength: 1 }),
    object: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
/** Provider-facing and runtime-facing graph extraction contract. */
export const GRAPH_EXTRACTION_SCHEMA = Type.Object({
    turn: TurnMemorySchema,
    triples: Type.Array(NavigationTripleSchema),
}, { additionalProperties: false });
export const GRAPH_EXTRACTION_TOOL_NAME = "submit_result";
export const GRAPH_EXTRACTION_TOOL = Object.freeze({
    name: GRAPH_EXTRACTION_TOOL_NAME,
    description: "Return one concise, self-contained summary and zero or more subject-predicate-object triples derived only from that summary. Match the parameter schema exactly and emit no text.",
    parameters: GRAPH_EXTRACTION_SCHEMA,
});
/** Fail closed before normalization or persistence when the contract is incomplete. */
export function assertGraphExtractionContract(value) {
    if (Value.Check(GRAPH_EXTRACTION_SCHEMA, value))
        return;
    const errors = Array.from(Value.Errors(GRAPH_EXTRACTION_SCHEMA, value))
        .slice(0, 3)
        .map(error => `${error.path || "/"}: ${error.message}`)
        .join("; ");
    throw new TypeError(`graph extraction contract violation${errors ? `: ${errors}` : ""}`);
}
