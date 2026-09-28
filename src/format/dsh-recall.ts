import type { GmNode, GmTurnMemory } from "../types.ts";
import type { GmNodeSource } from "../store/store.ts";

/** Keep recalled history before the live human instruction on the model surface. */
export function insertDshRecallBeforeCurrentUser(messages: any[], recalledMessage: any): any[] {
  const entered = [...messages];
  const currentUserIndex = entered.findIndex(message => message?.source?.kind === "user");
  entered.splice(currentUserIndex < 0 ? entered.length : currentUserIndex, 0, recalledMessage);
  return entered;
}

/**
 * Remove only memory that is already visible verbatim in DSH's fresh window.
 * Archived same-session evidence is first-class memory, alongside evidence
 * from other sessions; filtering the whole current session loses exactly the
 * history Graph Memory took off the provider surface.
 */
export function filterDshRecallNodes(
  nodes: GmNode[],
  sources: GmNodeSource[],
  currentSession: string,
  visibleMessageIds: ReadonlySet<string>,
  hasArchivedHistory: boolean,
): GmNode[] {
  const refsByNode = new Map<string, GmNodeSource[]>();
  for (const source of sources) {
    const refs = refsByNode.get(source.nodeId) ?? [];
    refs.push(source);
    refsByNode.set(source.nodeId, refs);
  }

  return nodes.filter(node => {
    if (node.sourceSessions.some(session => session !== currentSession)) return true;
    const refs = refsByNode.get(node.id) ?? [];
    if (refs.length) return refs.some(ref => !visibleMessageIds.has(ref.messageId));
    return hasArchivedHistory;
  });
}

/** Avoid replaying a compact summary whose exact Q/A is still visible. */
export function filterDshRecallMemories(
  memories: GmTurnMemory[],
  currentSession: string,
  visibleMessageIds: ReadonlySet<string>,
): GmTurnMemory[] {
  return memories.filter(memory =>
    memory.sessionId !== currentSession ||
    memory.sources.some(source => !visibleMessageIds.has(source.messageId))
  );
}
