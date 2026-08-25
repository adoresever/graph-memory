import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSyncInstance } from "../src/store/sqlite.ts";

import { Recaller } from "../src/recaller/recall.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import { createTestDb } from "./helpers.ts";
import { getVectorHash, saveVector, updateNode, upsertNode } from "../src/store/store.ts";

let db: DatabaseSyncInstance;

beforeEach(() => {
  db = createTestDb();
});

describe("Recaller.syncEmbed", () => {
  it("re-embeds when the description changes", async () => {
    const calls: string[] = [];
    const recaller = new Recaller(db, DEFAULT_CONFIG);
    recaller.setEmbedFn(async (text) => {
      calls.push(text);
      return [1, 0];
    });

    const { node } = upsertNode(db, {
      type: "SKILL",
      name: "docker-build",
      description: "old description",
      content: "same content",
    }, "s1");
    await recaller.syncEmbed(node);
    const firstHash = getVectorHash(db, node.id);

    const updated = updateNode(db, node.name, { description: "new description" })!;
    await recaller.syncEmbed(updated);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("old description");
    expect(calls[1]).toContain("new description");
    expect(getVectorHash(db, node.id)).not.toBe(firstHash);
  });

  it("keeps semantic relevance through graph ranking and embeds a query once", async () => {
    const strong = upsertNode(db, {
      type: "EVENT",
      name: "semantic-match",
      description: "relevant paraphrase",
      content: "the correct memory",
    }, "old-session").node;
    const weak = upsertNode(db, {
      type: "EVENT",
      name: "popular-distractor",
      description: "unrelated",
      content: "different topic",
    }, "old-session").node;
    db.prepare("UPDATE gm_nodes SET validated_count=100 WHERE id=?").run(weak.id);
    saveVector(db, strong.id, "strong", [1, 0]);
    saveVector(db, weak.id, "weak", [0.5, Math.sqrt(0.75)]);

    let queryCalls = 0;
    const recaller = new Recaller(db, { ...DEFAULT_CONFIG, recallMaxNodes: 2 });
    recaller.setEmbedFn(async (_text, purpose) => {
      if (purpose === "query") queryCalls += 1;
      return [1, 0];
    });
    const result = await recaller.recall("words absent from both stored nodes");

    expect(queryCalls).toBe(1);
    expect(result.nodes[0]?.id).toBe(strong.id);
  });

  it("supports a high-precision automatic mode without broad fallback", async () => {
    const weak = upsertNode(db, {
      type: "EVENT",
      name: "weak-neighbor",
      description: "only loosely related",
      content: "generic memory",
    }, "old-session").node;
    saveVector(db, weak.id, "weak", [0.55, Math.sqrt(1 - 0.55 ** 2)]);

    const recaller = new Recaller(db, DEFAULT_CONFIG);
    recaller.setEmbedFn(async () => [1, 0]);
    const result = await recaller.recall("unrelated current request", {
      minSemanticScore: 0.6,
      allowBroadFallback: false,
    });

    expect(result.nodes).toEqual([]);
  });
});
