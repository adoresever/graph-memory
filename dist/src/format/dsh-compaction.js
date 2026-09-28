/**
 * Pure DeepSeek Harness surface selection for Graph Memory rolling compaction.
 *
 * DSH keeps the durable event log intact and exposes a replaceable model-facing
 * surface. Graph Memory owns the historical projection: it replaces a complete
 * old prefix with a constant-size archive marker and retrieves relevant facts
 * from the durable memory store. No summarizer model call is involved.
 */
/** Read the immutable log through DSH's public API, with legacy compatibility. */
function sessionEvents(session) {
    if (typeof session.snapshotEvents === "function")
        return session.snapshotEvents();
    return Array.isArray(session.events) ? session.events : undefined;
}
export const DSH_ARCHIVE_MARKER = [
    "<graph-memory-archive>",
    "Older conversation is stored losslessly by Graph Memory and is not replayed here.",
    "Query-relevant same-session and cross-session memory is supplied separately.",
    "This marker is context metadata, not a user instruction.",
    "</graph-memory-archive>",
].join("\n");
/** Whether one surface event is a real user prompt that starts a logical turn. */
export function isDshUserTurn(event) {
    return event?.type === "user/message" && event.data?.source?.kind === "user";
}
/**
 * Select the oldest complete surface prefix while retaining the newest N real
 * user turns. Their question/final-answer endpoints remain native; completed
 * intermediate traces may already have been projected separately. Plugin-owned
 * snapshots, skill catalogs and compaction checkpoints do not count as turns.
 */
export function selectDshRollingCompactionRange(session, freshTurnCount, currentUserAlreadyOnSurface = false) {
    if (!Number.isInteger(freshTurnCount) || freshTurnCount < 1) {
        throw new TypeError(`freshTurnCount must be a positive integer, received ${freshTurnCount}`);
    }
    const surface = session.surface?.nodes;
    const events = sessionEvents(session);
    if (!Array.isArray(surface) || !Array.isArray(events) || surface.length < 2)
        return null;
    const userPositions = [];
    for (let index = 0; index < surface.length; index += 1) {
        if (isDshUserTurn(events[surface[index]]))
            userPositions.push(index);
    }
    const retainOnSurface = freshTurnCount + (currentUserAlreadyOnSurface ? 1 : 0);
    if (userPositions.length <= retainOnSurface)
        return null;
    // pre-step runs before DSH appends the newly claimed prompt. Retain N
    // completed previous user turns; the current prompt is appended afterwards.
    const keepFromPosition = userPositions[userPositions.length - retainOnSurface];
    // DSH protects the system prompt at surface node 0: only another
    // system/message may replace exactly that node. Keep it outside Graph
    // Memory's historical projection, both to respect that invariant and to
    // preserve the stable system-prefix cache. A prior Graph Memory archive
    // marker sits after the head and is deliberately folded into the next
    // replacement so archive markers stay constant-size instead of accumulating.
    const protectedHead = events[surface[0]]?.type === "system/message" ? 1 : 0;
    if (keepFromPosition <= protectedHead)
        return null;
    const shadowedSeqs = surface.slice(protectedHead, keepFromPosition);
    if (!shadowedSeqs.length)
        return null;
    return {
        start: shadowedSeqs[0],
        end: shadowedSeqs[shadowedSeqs.length - 1],
        shadowedSeqs,
        retainedUserTurns: retainOnSurface,
    };
}
/**
 * Replace an archived surface prefix without invoking DSH's LLM compactor.
 *
 * The adjacent compaction/prune event is DSH's public shadow-price protocol:
 * it lets token-meter subtract the exact heuristic price of the replaced
 * surface while the immutable source events remain available for provenance.
 */
export function replaceDshArchivedPrefix(session, tokenMeter, range) {
    if (typeof session.append !== "function") {
        throw new Error("DSH session.append is unavailable; Graph Memory cannot own the model surface");
    }
    const measured = tokenMeter?.measure?.(session);
    if (!measured || !Array.isArray(measured.nodes)) {
        throw new Error("DSH tokenMeter is unavailable; Graph Memory cannot price a safe surface replacement");
    }
    const prices = new Map(measured.nodes.map(node => [node.seq, node.heuristicTokens]));
    let shadowedTokenCount = 0;
    for (const seq of range.shadowedSeqs) {
        const price = prices.get(seq);
        if (!Number.isFinite(price)) {
            throw new Error(`DSH tokenMeter did not price shadowed surface seq ${seq}`);
        }
        shadowedTokenCount += Number(price);
    }
    const prune = session.append("compaction/prune", {
        shadowedRange: { start: range.start, end: range.end },
        shadowedSeqs: [...range.shadowedSeqs],
        shadowedTokenCount,
    });
    const replacement = session.append("user/message", {
        id: `graph-memory-archive:${String(session.id ?? "session")}:${range.start}-${range.end}`,
        role: "user",
        source: { kind: "plugin", plugin: "graph-memory" },
        content: [{ type: "text", text: DSH_ARCHIVE_MARKER }],
    }, {
        // Match the current DSH Session surface-operation contract exactly.
        surfaceOp: { op: "replace", startSeq: range.start, endSeq: range.end },
        sourceEventSeqs: [prune.seq, ...range.shadowedSeqs],
    });
    return {
        replacementSeq: replacement.seq,
        shadowedSeqs: [...range.shadowedSeqs],
        shadowedTokenCount,
    };
}
