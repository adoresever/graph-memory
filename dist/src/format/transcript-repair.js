/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */
const TOOL_CALL_TYPES = new Set([
    "toolCall", "toolUse", "tool_use", "tool-use",
    "functionCall", "function_call",
]);
function extractToolCallId(block) {
    if (typeof block.id === "string" && block.id)
        return block.id;
    if (typeof block.call_id === "string" && block.call_id)
        return block.call_id;
    return null;
}
function extractToolCallsFromAssistant(msg) {
    if (!Array.isArray(msg.content))
        return [];
    const calls = [];
    for (const block of msg.content) {
        if (!block || typeof block !== "object")
            continue;
        const rec = block;
        const id = extractToolCallId(rec);
        if (!id)
            continue;
        if (typeof rec.type === "string" && TOOL_CALL_TYPES.has(rec.type)) {
            calls.push({ id, name: typeof rec.name === "string" ? rec.name : undefined });
        }
    }
    return calls;
}
function extractToolResultId(msg) {
    if (typeof msg.toolCallId === "string" && msg.toolCallId)
        return msg.toolCallId;
    if (typeof msg.toolUseId === "string" && msg.toolUseId)
        return msg.toolUseId;
    return null;
}
function makeMissingToolResult(params) {
    return {
        role: "toolResult",
        toolCallId: params.toolCallId,
        toolName: params.toolName ?? "unknown",
        content: [{ type: "text", text: "[graph-memory] tool result missing after context trim." }],
        isError: true,
        timestamp: Date.now(),
    };
}
export function sanitizeToolUseResultPairing(messages) {
    const out = [];
    const seenToolResultIds = new Set();
    let changed = false;
    const pushToolResult = (msg) => {
        const id = extractToolResultId(msg);
        if (id && seenToolResultIds.has(id)) {
            changed = true;
            return;
        }
        if (id)
            seenToolResultIds.add(id);
        out.push(msg);
    };
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg || typeof msg !== "object") {
            out.push(msg);
            continue;
        }
        const role = msg.role;
        if (role !== "assistant") {
            if (role !== "toolResult") {
                out.push(msg);
            }
            else {
                changed = true;
            }
            continue;
        }
        const stopReason = msg.stopReason;
        if (stopReason === "error" || stopReason === "aborted") {
            out.push(msg);
            continue;
        }
        const toolCalls = extractToolCallsFromAssistant(msg);
        if (toolCalls.length === 0) {
            out.push(msg);
            continue;
        }
        const toolCallIds = new Set(toolCalls.map((t) => t.id));
        const spanResultsById = new Map();
        const remainder = [];
        let j = i + 1;
        for (; j < messages.length; j++) {
            const next = messages[j];
            if (!next || typeof next !== "object") {
                remainder.push(next);
                continue;
            }
            if (next.role === "assistant")
                break;
            if (next.role === "toolResult") {
                const id = extractToolResultId(next);
                if (id && toolCallIds.has(id)) {
                    if (seenToolResultIds.has(id)) {
                        changed = true;
                        continue;
                    }
                    if (!spanResultsById.has(id))
                        spanResultsById.set(id, next);
                    continue;
                }
            }
            if (next.role !== "toolResult") {
                remainder.push(next);
            }
            else {
                changed = true;
            }
        }
        out.push(msg);
        if (spanResultsById.size > 0 && remainder.length > 0)
            changed = true;
        for (const call of toolCalls) {
            const existing = spanResultsById.get(call.id);
            if (existing) {
                pushToolResult(existing);
            }
            else {
                changed = true;
                pushToolResult(makeMissingToolResult({ toolCallId: call.id, toolName: call.name }));
            }
        }
        for (const rem of remainder)
            out.push(rem);
        i = j - 1;
    }
    return changed ? out : messages;
}
