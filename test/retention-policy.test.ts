import { describe, expect, it } from "vitest";

import {
  normalizeMessageRetentionPolicy,
  messageRetentionPolicyRevision,
} from "../src/store/retention.ts";

describe("normalizeMessageRetentionPolicy", () => {
  it("defaults to keep=all with no pruning and bounded batches", () => {
    expect(normalizeMessageRetentionPolicy(undefined)).toEqual({
      keep: "all", recentTurns: 0, retentionDays: 0, batchSize: 500, dryRun: false,
    });
    expect(normalizeMessageRetentionPolicy({})).toEqual({
      keep: "all", recentTurns: 0, retentionDays: 0, batchSize: 500, dryRun: false,
    });
  });

  it("accepts a valid recent policy", () => {
    const policy = normalizeMessageRetentionPolicy({
      keep: "recent", recentTurns: 3, retentionDays: 30, batchSize: 100, dryRun: true,
    });
    expect(policy).toEqual({
      keep: "recent", recentTurns: 3, retentionDays: 30, batchSize: 100, dryRun: true,
    });
  });

  it("accepts keep=referenced without window params", () => {
    expect(normalizeMessageRetentionPolicy({ keep: "referenced" }).keep).toBe("referenced");
  });

  it("rejects invalid keep mode and non-object input", () => {
    expect(() => normalizeMessageRetentionPolicy({ keep: "aggressive" } as any)).toThrow(TypeError);
    expect(() => normalizeMessageRetentionPolicy("recent" as any)).toThrow(TypeError);
    expect(() => normalizeMessageRetentionPolicy([] as any)).toThrow(TypeError);
  });

  it("keep=recent requires at least one window parameter", () => {
    expect(() => normalizeMessageRetentionPolicy({ keep: "recent" })).toThrow(/requires recentTurns or retentionDays/);
  });

  it("rejects out-of-bounds and non-integer numeric fields", () => {
    expect(() => normalizeMessageRetentionPolicy({ batchSize: 0 })).toThrow(/batchSize/);
    expect(() => normalizeMessageRetentionPolicy({ batchSize: 10_001 })).toThrow(/batchSize/);
    expect(() => normalizeMessageRetentionPolicy({ batchSize: 12.5 })).toThrow(/batchSize/);
    expect(() => normalizeMessageRetentionPolicy({ recentTurns: -1 })).toThrow(/recentTurns/);
    expect(() => normalizeMessageRetentionPolicy({ retentionDays: 40_000 })).toThrow(/retentionDays/);
  });

  it("rejects non-boolean dryRun", () => {
    expect(() => normalizeMessageRetentionPolicy({ dryRun: "yes" as any })).toThrow(/dryRun/);
  });

  it("revision is stable for identical policies and differs across policies", () => {
    const a = normalizeMessageRetentionPolicy({ keep: "referenced", batchSize: 100 });
    const b = normalizeMessageRetentionPolicy({ keep: "referenced", batchSize: 100 });
    const c = normalizeMessageRetentionPolicy({ keep: "referenced", batchSize: 200 });
    expect(messageRetentionPolicyRevision(a)).toBe(messageRetentionPolicyRevision(b));
    expect(messageRetentionPolicyRevision(a)).not.toBe(messageRetentionPolicyRevision(c));
  });
});
