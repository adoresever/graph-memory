/**
 * Model-surface projection for one completed DeepSeek Harness turn.
 *
 * DSH keeps the immutable event log as the source of truth. Once a turn has
 * completed, Graph Memory may hide the contiguous tool/reasoning trace between
 * the original user question and the final assistant answer. Both endpoints
 * remain native messages on the model surface; the hidden trace remains in the
 * durable DSH log. Graph Memory stores only the question and final answer in
 * gm_messages for extraction and source-backed recall.
 */
/** Read only public text blocks. Reasoning and tool payloads are not memory. */
function visibleText(content) {
    if (typeof content === "string")
        return content.trim();
    if (!Array.isArray(content))
        return "";
    return content
        .filter(block => block && typeof block === "object" && block.type === "text")
        .map(block => typeof block.text === "string" ? block.text : "")
        .filter(Boolean)
        .join("\n")
        .trim();
}
/** Read the immutable log through DSH's public API, with legacy compatibility. */
function sessionEvents(session) {
    if (typeof session.snapshotEvents === "function")
        return session.snapshotEvents();
    return Array.isArray(session.events) ? session.events : undefined;
}
function hasVisibleAssistantText(event) {
    if (event?.type !== "assistant/message")
        return false;
    const content = event.data?.message?.content;
    if (!Array.isArray(content))
        return false;
    return content.some(block => (block && typeof block === "object"
        && block.type === "text"
        && typeof block.text === "string"
        && block.text.trim().length > 0));
}
/**
 * Fold one immutable DSH turn into Graph Memory's semantic source pair.
 *
 * This mirrors DSH's turn-outline lifecycle (first human prompt, newest
 * text-bearing assistant response, commit at turn/end) without its UI preview
 * clipping. Intermediate assistant steps, reasoning and tool traffic are
 * deliberately excluded.
 */
export function projectDshCompletedTurnMemory(session, turn, turnEndSeq) {
    if (!Number.isInteger(turn) || turn < 1)
        return null;
    const events = sessionEvents(session);
    if (!events)
        return null;
    const endSeq = Number.isInteger(turnEndSeq) ? Number(turnEndSeq) : events.length;
    let startSeq = -1;
    for (let seq = Math.min(endSeq - 1, events.length - 1); seq >= 0; seq -= 1) {
        const event = events[seq];
        if (event?.type === "turn/start" && event.data?.turn === turn) {
            startSeq = seq;
            break;
        }
    }
    if (startSeq < 0)
        return null;
    let questionSeq = -1;
    let userQuestion = "";
    let finalAnswerSeq = -1;
    let finalAnswer = "";
    for (let seq = startSeq + 1; seq < Math.min(endSeq, events.length); seq += 1) {
        const event = events[seq];
        if (!event || event.surfaceOp && event.surfaceOp !== "append")
            continue;
        if (questionSeq < 0 && event.type === "user/message" && event.data?.source?.kind === "user") {
            const text = visibleText(event.data.content);
            if (text) {
                questionSeq = seq;
                userQuestion = text;
            }
            continue;
        }
        if (questionSeq >= 0 && event.type === "assistant/message") {
            const text = visibleText(event.data?.message?.content);
            if (text) {
                finalAnswerSeq = seq;
                finalAnswer = text;
            }
        }
    }
    if (questionSeq < 0 || finalAnswerSeq < 0)
        return null;
    return { turn, questionSeq, finalAnswerSeq, userQuestion, finalAnswer };
}
/**
 * Select only the middle trace of a completed turn. The question and final
 * visible answer are deliberately excluded from the replacement range.
 */
export function selectDshCompletedTurnTraceRange(session, turn, turnEndSeq) {
    if (!Number.isInteger(turn) || turn < 1)
        return null;
    const events = sessionEvents(session);
    const surface = session.surface?.nodes;
    if (!Array.isArray(events) || !Array.isArray(surface))
        return null;
    const endSeq = Number.isInteger(turnEndSeq) ? Number(turnEndSeq) : events.length;
    let startSeq = -1;
    for (let seq = Math.min(endSeq - 1, events.length - 1); seq >= 0; seq -= 1) {
        const event = events[seq];
        if (event?.type === "turn/start" && event.data?.turn === turn) {
            startSeq = seq;
            break;
        }
    }
    if (startSeq < 0)
        return null;
    const positions = [];
    for (let position = 0; position < surface.length; position += 1) {
        const seq = surface[position];
        if (seq > startSeq && seq < endSeq)
            positions.push(position);
    }
    if (positions.length < 3)
        return null;
    const questionPosition = positions.find(position => {
        const event = events[surface[position]];
        return event?.type === "user/message" && event.data?.source?.kind === "user";
    });
    if (questionPosition === undefined)
        return null;
    let finalAnswerPosition = -1;
    for (const position of positions) {
        const event = events[surface[position]];
        if (position > questionPosition && event?.data?.turn === turn && hasVisibleAssistantText(event)) {
            finalAnswerPosition = position;
        }
    }
    if (finalAnswerPosition <= questionPosition + 1)
        return null;
    const shadowedSeqs = surface.slice(questionPosition + 1, finalAnswerPosition);
    if (!shadowedSeqs.length)
        return null;
    return {
        turn,
        start: shadowedSeqs[0],
        end: shadowedSeqs[shadowedSeqs.length - 1],
        shadowedSeqs,
        questionSeq: surface[questionPosition],
        finalAnswerSeq: surface[finalAnswerPosition],
    };
}
/** Replace a completed tool trace with a constant-size, model-free marker. */
export function replaceDshCompletedTurnTrace(session, tokenMeter, range) {
    if (typeof session.append !== "function")
        throw new Error("DSH session.append is unavailable");
    const measured = tokenMeter?.measure?.(session);
    if (!measured || !Array.isArray(measured.nodes))
        throw new Error("DSH tokenMeter is unavailable");
    const prices = new Map(measured.nodes.map(node => [node.seq, node.heuristicTokens]));
    let shadowedTokenCount = 0;
    for (const seq of range.shadowedSeqs) {
        const price = prices.get(seq);
        if (!Number.isFinite(price))
            throw new Error(`DSH tokenMeter did not price surface seq ${seq}`);
        shadowedTokenCount += Number(price);
    }
    const prune = session.append("compaction/prune", {
        shadowedRange: { start: range.start, end: range.end },
        shadowedSeqs: [...range.shadowedSeqs],
        shadowedTokenCount,
    });
    const replacement = session.append("user/message", {
        id: `graph-memory-turn-trace:${String(session.id ?? "session")}:${range.turn}`,
        role: "user",
        source: { kind: "plugin", plugin: "graph-memory" },
        content: [{
                type: "text",
                text: `<graph-memory-trace turn="${range.turn}">Intermediate tool trace archived; the original question and final answer remain visible.</graph-memory-trace>`,
            }],
    }, {
        // DSH's public surface protocol names replacement bounds startSeq/endSeq.
        // Using start/end writes the adjacent prune audit event but causes the
        // actual surface append to be rejected, leaving the old trace visible.
        surfaceOp: { op: "replace", startSeq: range.start, endSeq: range.end },
        sourceEventSeqs: [prune.seq, ...range.shadowedSeqs],
    });
    return {
        replacementSeq: replacement.seq,
        shadowedSeqs: [...range.shadowedSeqs],
        shadowedTokenCount,
    };
}
