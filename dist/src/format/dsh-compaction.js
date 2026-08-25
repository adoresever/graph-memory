/**
 * Pure DeepSeek Harness surface selection for Graph Memory rolling compaction.
 *
 * DSH keeps the durable event log intact and exposes a replaceable model-facing
 * surface. Graph Memory selects only a complete prefix of that surface; the
 * host compaction service owns the actual summary transaction and tool-pairing
 * validation.
 */
/** Whether one surface event is a real user prompt that starts a logical turn. */
export function isDshUserTurn(event) {
    return event?.type === "user/message" && event.data?.source?.kind === "user";
}
/**
 * Select the oldest complete surface prefix while retaining the newest N user
 * turns verbatim. Plugin-owned user messages (prompt snapshots, skill catalogs,
 * compaction checkpoints) do not count as user turns.
 */
export function selectDshRollingCompactionRange(session, freshTurnCount, incomingUserTurns = 0) {
    if (!Number.isInteger(freshTurnCount) || freshTurnCount < 1) {
        throw new TypeError(`freshTurnCount must be a positive integer, received ${freshTurnCount}`);
    }
    if (!Number.isInteger(incomingUserTurns) || incomingUserTurns < 0) {
        throw new TypeError(`incomingUserTurns must be a non-negative integer, received ${incomingUserTurns}`);
    }
    const surface = session.surface?.nodes;
    const events = session.events;
    if (!Array.isArray(surface) || !Array.isArray(events) || surface.length < 2)
        return null;
    const userPositions = [];
    for (let index = 0; index < surface.length; index += 1) {
        if (isDshUserTurn(events[surface[index]]))
            userPositions.push(index);
    }
    if (userPositions.length + incomingUserTurns <= freshTurnCount)
        return null;
    const retainOnSurface = Math.max(0, freshTurnCount - incomingUserTurns);
    const keepFromPosition = retainOnSurface === 0
        ? surface.length
        : userPositions[userPositions.length - retainOnSurface];
    if (keepFromPosition <= 0)
        return null;
    const shadowedSeqs = surface.slice(0, keepFromPosition);
    if (!shadowedSeqs.length)
        return null;
    return {
        start: shadowedSeqs[0],
        end: shadowedSeqs[shadowedSeqs.length - 1],
        shadowedSeqs,
        retainedUserTurns: freshTurnCount,
    };
}
