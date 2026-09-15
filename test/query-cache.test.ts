/**
 * 查询向量 LRU 单测 — 低成本调用节约（重复查询零 embedding API 调用）
 */

import { describe, it, expect } from "vitest";
import { QueryVecCache } from "../src/recaller/query-cache.ts";

describe("QueryVecCache", () => {
  it("基础 get/set/miss", () => {
    const cache = new QueryVecCache(4);
    expect(cache.get("q1")).toBeUndefined();
    cache.set("q1", [1, 2, 3]);
    expect(cache.get("q1")).toEqual([1, 2, 3]);
  });

  it("容量满时淘汰最旧条目", () => {
    const cache = new QueryVecCache(2);
    cache.set("a", [1]);
    cache.set("b", [2]);
    cache.set("c", [3]); // 淘汰 a
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toEqual([2]);
    expect(cache.get("c")).toEqual([3]);
    expect(cache.size).toBe(2);
  });

  it("命中会刷新 LRU 顺序（最近使用的不会被淘汰）", () => {
    const cache = new QueryVecCache(2);
    cache.set("a", [1]);
    cache.set("b", [2]);
    cache.get("a");          // a 变为最新
    cache.set("c", [3]);     // 淘汰 b 而非 a
    expect(cache.get("a")).toEqual([1]);
    expect(cache.get("b")).toBeUndefined();
  });

  it("重复 set 同 key 不占额外槽位", () => {
    const cache = new QueryVecCache(2);
    cache.set("a", [1]);
    cache.set("a", [9]);
    cache.set("b", [2]);
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toEqual([9]);
  });

  it("clear 清空全部（embedding 端点切换时）", () => {
    const cache = new QueryVecCache(4);
    cache.set("a", [1]);
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});
