import { describe, it, expect } from "vitest";
import {
  normalizeImportance,
  computeConfidence,
  computeBeta,
  scoreRecency,
  scoreFrequency,
  scoreIntrinsic,
  scoreNode,
  decideTierTransition,
  shouldAutoDeprecate,
} from "../src/graph/decay.ts";
import { DEFAULT_CONFIG, type DecayConfig, type GmNode } from "../src/types.ts";

const cfg: DecayConfig = { ...DEFAULT_CONFIG.decay! };
const NOW = Date.UTC(2026, 0, 15, 0, 0, 0);
const MS_PER_DAY = 86_400_000;

function makeNode(overrides: Partial<GmNode> = {}): GmNode {
  return {
    id: "test-id",
    type: "SKILL",
    name: "test",
    description: "",
    content: "",
    status: "active",
    tier: "working",
    validatedCount: 1,
    sourceSessions: [],
    communityId: null,
    pagerank: 0,
    createdAt: NOW - 10 * MS_PER_DAY,
    updatedAt: NOW - 10 * MS_PER_DAY,
    lastAccessedAt: NOW - 10 * MS_PER_DAY,
    ...overrides,
  };
}

describe("normalizeImportance", () => {
  it("pagerank=0 时返回 0（即使 maxPagerank>0）", () => {
    expect(normalizeImportance(0, 1.0)).toBe(0);
  });

  it("maxPagerank≤0 时返回 0（避免除零）", () => {
    expect(normalizeImportance(5, 0)).toBe(0);
    expect(normalizeImportance(5, -1)).toBe(0);
  });

  it("pagerank = maxPagerank 时返回 1", () => {
    expect(normalizeImportance(0.5, 0.5)).toBe(1);
  });

  it("截断到 [0,1]", () => {
    expect(normalizeImportance(2.0, 1.0)).toBe(1);
    expect(normalizeImportance(-1, 1.0)).toBe(0);
  });
});

describe("computeConfidence", () => {
  it("count=0 时 confidence=0", () => {
    expect(computeConfidence(0)).toBe(0);
  });

  it("count=1 时 confidence=0.5", () => {
    expect(computeConfidence(1)).toBeCloseTo(0.5, 6);
  });

  it("count 增大时饱和收敛到 1（永不达到）", () => {
    expect(computeConfidence(10)).toBeLessThan(1);
    expect(computeConfidence(100)).toBeLessThan(1);
    expect(computeConfidence(100)).toBeGreaterThan(computeConfidence(10));
  });

  it("负数按 0 处理", () => {
    expect(computeConfidence(-5)).toBe(0);
  });
});

describe("computeBeta", () => {
  it("core < working < peripheral（缓衰 → 促衰）", () => {
    expect(computeBeta("core", cfg)).toBe(0.8);
    expect(computeBeta("working", cfg)).toBe(1.0);
    expect(computeBeta("peripheral", cfg)).toBe(1.3);
  });
});

describe("scoreRecency", () => {
  it("刚刚访问（daysSince=0）→ 1.0", () => {
    const node = makeNode({ lastAccessedAt: NOW });
    expect(scoreRecency(node, 0, NOW, cfg)).toBeCloseTo(1, 6);
  });

  it("importance=0 + working tier + 30 天 → recency ≈ 0.5（半衰期）", () => {
    const node = makeNode({ tier: "working", lastAccessedAt: NOW - 30 * MS_PER_DAY });
    expect(scoreRecency(node, 0, NOW, cfg)).toBeCloseTo(0.5, 2);
  });

  it("高 importance 拉长 effectiveHL（衰减更慢）", () => {
    const node = makeNode({ tier: "working", lastAccessedAt: NOW - 30 * MS_PER_DAY });
    const highImp = scoreRecency(node, 1.0, NOW, cfg);
    const zeroImp = scoreRecency(node, 0, NOW, cfg);
    expect(highImp).toBeGreaterThan(zeroImp);
    expect(highImp).toBeGreaterThan(0.5);
  });

  it("tier=peripheral 比 tier=working 衰减更快", () => {
    const days = 10;
    const w = scoreRecency(makeNode({ tier: "working", lastAccessedAt: NOW - days * MS_PER_DAY }), 0, NOW, cfg);
    const p = scoreRecency(makeNode({ tier: "peripheral", lastAccessedAt: NOW - days * MS_PER_DAY }), 0, NOW, cfg);
    expect(p).toBeLessThan(w);
  });

  it("lastAccessedAt 缺失时回退到 updatedAt", () => {
    const viaFallback = makeNode({ lastAccessedAt: 0, updatedAt: NOW - 5 * MS_PER_DAY });
    const direct = makeNode({ lastAccessedAt: NOW - 5 * MS_PER_DAY });
    expect(scoreRecency(viaFallback, 0, NOW, cfg))
      .toBeCloseTo(scoreRecency(direct, 0, NOW, cfg), 6);
  });
});

describe("scoreFrequency", () => {
  it("count=0 时 base=0", () => {
    expect(scoreFrequency(makeNode({ validatedCount: 0 }))).toBe(0);
  });

  it("count=1 时只返回 base（无 recentnessBonus）", () => {
    const expected = 1 - Math.exp(-1 / 5);
    expect(scoreFrequency(makeNode({ validatedCount: 1 }))).toBeCloseTo(expected, 6);
  });

  it("count > 1 时 base × (0.5 + 0.5*recentnessBonus)，结果 ≤ base", () => {
    const node = makeNode({
      validatedCount: 3,
      createdAt: NOW - 30 * MS_PER_DAY,
      lastAccessedAt: NOW,
    });
    const base = 1 - Math.exp(-3 / 5);
    const score = scoreFrequency(node);
    expect(score).toBeLessThanOrEqual(base);
    expect(score).toBeGreaterThan(0);
  });

  it("访问越紧凑（avgGapDays 越小）recentnessBonus 越大", () => {
    const tight = makeNode({
      validatedCount: 5,
      createdAt: NOW - 4 * MS_PER_DAY,
      lastAccessedAt: NOW,
    });
    const sparse = makeNode({
      validatedCount: 5,
      createdAt: NOW - 100 * MS_PER_DAY,
      lastAccessedAt: NOW,
    });
    expect(scoreFrequency(tight)).toBeGreaterThan(scoreFrequency(sparse));
  });
});

describe("scoreIntrinsic", () => {
  it("= importance × confidence", () => {
    expect(scoreIntrinsic(0.5, 0.5)).toBeCloseTo(0.25, 6);
    expect(scoreIntrinsic(1, 1)).toBe(1);
    expect(scoreIntrinsic(0, 0.5)).toBe(0);
  });
});

describe("scoreNode", () => {
  it("权重和为 1 时 composite 落在 [0,1]", () => {
    const node = makeNode({ pagerank: 0.5, validatedCount: 5, lastAccessedAt: NOW });
    const r = scoreNode(node, 1.0, NOW, cfg);
    expect(r.composite).toBeGreaterThanOrEqual(0);
    expect(r.composite).toBeLessThanOrEqual(1);
  });

  it("新鲜高 PR 节点 composite 显著高于陈旧低 PR 节点", () => {
    const fresh = makeNode({ pagerank: 1.0, validatedCount: 1, lastAccessedAt: NOW });
    const stale = makeNode({
      pagerank: 0,
      validatedCount: 1,
      lastAccessedAt: NOW - 90 * MS_PER_DAY,
    });
    expect(scoreNode(fresh, 1.0, NOW, cfg).composite)
      .toBeGreaterThan(scoreNode(stale, 1.0, NOW, cfg).composite);
  });

  it("权重和≠1 时自动归一化，composite 仍落在 [0,1]", () => {
    const skewedCfg: DecayConfig = {
      ...cfg,
      recencyWeight: 0.5,
      frequencyWeight: 0.5,
      intrinsicWeight: 0.5, // 和=1.5
    };
    const node = makeNode({
      pagerank: 1.0,
      validatedCount: 10,
      lastAccessedAt: NOW,
      updatedAt: NOW,
      createdAt: NOW,
    });
    const r = scoreNode(node, 1.0, NOW, skewedCfg);
    expect(r.composite).toBeLessThanOrEqual(1);
    expect(r.composite).toBeGreaterThanOrEqual(0);
  });

  it("权重和为 0 时回退到等权重，不抛错", () => {
    const zeroCfg: DecayConfig = {
      ...cfg,
      recencyWeight: 0,
      frequencyWeight: 0,
      intrinsicWeight: 0,
    };
    const node = makeNode({ pagerank: 0.5, validatedCount: 1, lastAccessedAt: NOW });
    const r = scoreNode(node, 1.0, NOW, zeroCfg);
    expect(Number.isFinite(r.composite)).toBe(true);
  });
});

describe("decideTierTransition", () => {
  const scoreLow = { composite: 0.1, recency: 0, frequency: 0, intrinsic: 0 };
  const scoreHigh = { composite: 0.9, recency: 0.9, frequency: 0.9, intrinsic: 0.9 };
  const scoreMid = { composite: 0.5, recency: 0.5, frequency: 0.5, intrinsic: 0 };

  it("core + composite 低 + count 低 → working", () => {
    const node = makeNode({ tier: "core", validatedCount: 1 });
    expect(decideTierTransition(node, scoreLow, 0, cfg, NOW)).toBe("working");
  });

  it("core + composite 高 → 保持 core", () => {
    const node = makeNode({ tier: "core", validatedCount: 20 });
    expect(decideTierTransition(node, scoreHigh, 0.9, cfg, NOW)).toBeNull();
  });

  it("working + composite < pct → peripheral", () => {
    const node = makeNode({ tier: "working", validatedCount: 1 });
    expect(decideTierTransition(node, scoreLow, 0, cfg, NOW)).toBe("peripheral");
  });

  it("working + 陈旧（age > peripheralAgeDays）+ count 低 → peripheral", () => {
    const node = makeNode({
      tier: "working",
      validatedCount: 1,
      createdAt: NOW - (cfg.peripheralAgeDays + 1) * MS_PER_DAY,
    });
    expect(decideTierTransition(node, scoreMid, 0, cfg, NOW)).toBe("peripheral");
  });

  it("working + 陈旧但 count 充足 → 保持 working", () => {
    const node = makeNode({
      tier: "working",
      validatedCount: 5,
      createdAt: NOW - (cfg.peripheralAgeDays + 1) * MS_PER_DAY,
    });
    expect(decideTierTransition(node, scoreMid, 0, cfg, NOW)).toBeNull();
  });

  it("peripheral + count 充足 + composite 高 → working", () => {
    const node = makeNode({ tier: "peripheral", validatedCount: 5 });
    expect(decideTierTransition(node, scoreMid, 0, cfg, NOW)).toBe("working");
  });

  it("peripheral + count 不足 → 保持 peripheral", () => {
    const node = makeNode({ tier: "peripheral", validatedCount: 1 });
    expect(decideTierTransition(node, scoreHigh, 0, cfg, NOW)).toBeNull();
  });

  it("working + count + composite + importance 都高 → core", () => {
    const node = makeNode({ tier: "working", validatedCount: 15 });
    expect(decideTierTransition(node, scoreHigh, 0.9, cfg, NOW)).toBe("core");
  });

  it("working + count + composite 高但 importance 不足 → 保持 working", () => {
    const node = makeNode({ tier: "working", validatedCount: 15 });
    expect(decideTierTransition(node, scoreHigh, 0.5, cfg, NOW)).toBeNull();
  });

  it("tier undefined 按 working 处理", () => {
    const node = makeNode({ tier: undefined as unknown as GmNode["tier"], validatedCount: 1 });
    expect(decideTierTransition(node, scoreLow, 0, cfg, NOW)).toBe("peripheral");
  });
});

describe("shouldAutoDeprecate", () => {
  // peripheralCompositeThreshold=0.15：低分 0.1 / 达标 0.5
  const scoreLow = { composite: 0.1, recency: 0, frequency: 0, intrinsic: 0 };
  const scoreHigh = { composite: 0.5, recency: 0.5, frequency: 0.5, intrinsic: 0.5 };

  it("peripheral + 低分 + 超期未访问 → true（三条件齐备）", () => {
    const node = makeNode({ tier: "peripheral", lastAccessedAt: NOW - 40 * MS_PER_DAY });
    expect(shouldAutoDeprecate(node, scoreLow, cfg, NOW)).toBe(true);
  });

  it("working 层 → false（遗忘曲线 tier 转换先行）", () => {
    const node = makeNode({ tier: "working", lastAccessedAt: NOW - 40 * MS_PER_DAY });
    expect(shouldAutoDeprecate(node, scoreLow, cfg, NOW)).toBe(false);
  });

  it("core 层 → false", () => {
    const node = makeNode({ tier: "core", lastAccessedAt: NOW - 40 * MS_PER_DAY });
    expect(shouldAutoDeprecate(node, scoreLow, cfg, NOW)).toBe(false);
  });

  it("composite 达标 → false（高 intrinsic 价值节点受保护）", () => {
    const node = makeNode({ tier: "peripheral", lastAccessedAt: NOW - 40 * MS_PER_DAY });
    expect(shouldAutoDeprecate(node, scoreHigh, cfg, NOW)).toBe(false);
  });

  it("composite 恰等于阈值 → false（边界取保留）", () => {
    const scoreAtThreshold = { composite: cfg.peripheralCompositeThreshold, recency: 0, frequency: 0, intrinsic: 0 };
    const node = makeNode({ tier: "peripheral", lastAccessedAt: NOW - 40 * MS_PER_DAY });
    expect(shouldAutoDeprecate(node, scoreAtThreshold, cfg, NOW)).toBe(false);
  });

  it("未超 autoDeprecateAfterDays → false", () => {
    const node = makeNode({ tier: "peripheral", lastAccessedAt: NOW - 10 * MS_PER_DAY });
    expect(shouldAutoDeprecate(node, scoreLow, cfg, NOW)).toBe(false);
  });

  it("恰好达到天数门槛 → true（>= 含端点）", () => {
    const node = makeNode({ tier: "peripheral", lastAccessedAt: NOW - cfg.autoDeprecateAfterDays * MS_PER_DAY });
    expect(shouldAutoDeprecate(node, scoreLow, cfg, NOW)).toBe(true);
  });

  it("autoDeprecate=false 恒 false（功能开关）", () => {
    const offCfg: DecayConfig = { ...cfg, autoDeprecate: false };
    const node = makeNode({ tier: "peripheral", lastAccessedAt: NOW - 400 * MS_PER_DAY });
    expect(shouldAutoDeprecate(node, scoreLow, offCfg, NOW)).toBe(false);
  });

  it("lastAccessedAt 缺失时回退 updatedAt（与 decay 计时基准一致）", () => {
    const viaFallback = makeNode({
      tier: "peripheral",
      lastAccessedAt: 0,
      updatedAt: NOW - (cfg.autoDeprecateAfterDays + 5) * MS_PER_DAY,
    });
    expect(shouldAutoDeprecate(viaFallback, scoreLow, cfg, NOW)).toBe(true);
  });

  it("tier undefined 按 working 处理 → false", () => {
    const node = makeNode({
      tier: undefined as unknown as GmNode["tier"],
      lastAccessedAt: NOW - 400 * MS_PER_DAY,
    });
    expect(shouldAutoDeprecate(node, scoreLow, cfg, NOW)).toBe(false);
  });
});
