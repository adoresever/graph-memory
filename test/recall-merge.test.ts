/**
 * graph-memory — 双路径召回合并配额测试
 *
 * By: adoresever
 *
 * 验证 mergeResults 的配额语义：精确路径优先，泛化路径只补精确路径未覆盖的
 * 社区，且总节点数封顶 limit —— 避免双路径全量合并导致节点数翻倍。
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";

import { Recaller } from "../src/recaller/recall.ts";
import { DEFAULT_CONFIG, type GmNode, type RecallResult } from "../src/types.ts";
import { createTestDb, insertNode } from "./helpers.ts";
import { findById } from "../src/store/store.ts";

let db: DatabaseSyncInstance;

beforeEach(() => {
  db = createTestDb();
});

function nodeWithCommunity(name: string, communityId: string | null): GmNode {
  const id = insertNode(db, { name });
  if (communityId) {
    db.prepare("UPDATE gm_nodes SET community_id=? WHERE id=?").run(communityId, id);
  }
  return findById(db, id)!;
}

function result(nodes: GmNode[]): RecallResult {
  return { nodes, edges: [], tokenEstimate: 0 };
}

// mergeResults 是 private，测试通过运行时访问覆盖其配额逻辑。
function merge(recaller: Recaller, precise: RecallResult, generalized: RecallResult, limit: number) {
  return (recaller as any).mergeResults(precise, generalized, limit) as RecallResult;
}

describe("mergeResults 配额", () => {
  it("精确路径满 limit 时泛化不补入", () => {
    const recaller = new Recaller(db, DEFAULT_CONFIG);
    const preciseNodes = Array.from({ length: 6 }, (_, i) => nodeWithCommunity(`p-${i}`, `c-p-${i}`));
    const genNodes = [nodeWithCommunity("g-0", "c-g-0"), nodeWithCommunity("g-1", "c-g-1")];

    const merged = merge(recaller, result(preciseNodes), result(genNodes), 6);

    expect(merged.nodes).toHaveLength(6);
    const names = merged.nodes.map((n: GmNode) => n.name);
    expect(names).not.toContain("g-0");
    expect(names).not.toContain("g-1");
  });

  it("泛化只补精确路径未覆盖的社区", () => {
    const recaller = new Recaller(db, DEFAULT_CONFIG);
    const precise = [nodeWithCommunity("p-0", "c-1")];
    const gen = [
      nodeWithCommunity("g-same-comm", "c-1"), // 同社区 → 冗余，跳过
      nodeWithCommunity("g-new-comm", "c-2"),  // 新社区 → 补入
    ];

    const merged = merge(recaller, result(precise), result(gen), 6);

    const names = merged.nodes.map((n: GmNode) => n.name);
    expect(names).toContain("g-new-comm");
    expect(names).not.toContain("g-same-comm");
    expect(merged.nodes).toHaveLength(2);
  });

  it("泛化补入受总配额封顶", () => {
    const recaller = new Recaller(db, DEFAULT_CONFIG);
    const precise = Array.from({ length: 4 }, (_, i) => nodeWithCommunity(`p-${i}`, `c-p-${i}`));
    const gen = [
      nodeWithCommunity("g-0", "c-g-0"),
      nodeWithCommunity("g-1", "c-g-1"),
      nodeWithCommunity("g-2", "c-g-2"),
    ];

    const merged = merge(recaller, result(precise), result(gen), 6);

    // 精确已 4 个，泛化最多补 2 个到 limit=6
    expect(merged.nodes).toHaveLength(6);
  });

  it("泛化无社区节点仍可补入", () => {
    const recaller = new Recaller(db, DEFAULT_CONFIG);
    const precise = [nodeWithCommunity("p-0", "c-1")];
    const gen = [nodeWithCommunity("g-no-comm", null)]; // 无社区节点

    const merged = merge(recaller, result(precise), result(gen), 6);

    const names = merged.nodes.map((n: GmNode) => n.name);
    expect(names).toContain("g-no-comm");
  });
});
