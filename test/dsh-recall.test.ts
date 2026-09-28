import { describe, expect, it } from "vitest";

import { filterDshRecallNodes, insertDshRecallBeforeCurrentUser } from "../src/format/dsh-recall.ts";

function node(id: string, sourceSessions: string[]) {
  return { id, sourceSessions, status: "active" } as any;
}

describe("DSH recall visibility", () => {
  it("places recalled history before the live user instruction", () => {
    const system = { role: "system", source: { kind: "plugin" } };
    const current = { role: "user", source: { kind: "user" }, content: "do the task" };
    const recall = { role: "user", source: { kind: "plugin", plugin: "graph-memory" } };
    expect(insertDshRecallBeforeCurrentUser([system, current], recall)).toEqual([system, recall, current]);
  });

  it("keeps archived same-session and cross-session memory but removes fresh duplicates", () => {
    const nodes = [
      node("fresh", ["dsh:current"]),
      node("archived", ["dsh:current"]),
      node("cross", ["dsh:other"]),
      node("mixed", ["dsh:current", "dsh:other"]),
    ];
    const sources = [
      { nodeId: "fresh", sessionId: "dsh:current", messageId: "dsh:current:10", turnIndex: 10 },
      { nodeId: "archived", sessionId: "dsh:current", messageId: "dsh:current:2", turnIndex: 2 },
      { nodeId: "cross", sessionId: "dsh:other", messageId: "dsh:other:3", turnIndex: 3 },
      { nodeId: "mixed", sessionId: "dsh:current", messageId: "dsh:current:10", turnIndex: 10 },
    ];

    expect(filterDshRecallNodes(
      nodes,
      sources,
      "dsh:current",
      new Set(["dsh:current:10"]),
      true,
    ).map(value => value.id)).toEqual(["archived", "cross", "mixed"]);
  });

  it("does not invent current-session memory without provenance before archival", () => {
    expect(filterDshRecallNodes(
      [node("unknown", ["dsh:current"])],
      [],
      "dsh:current",
      new Set(),
      false,
    )).toEqual([]);
  });
});
