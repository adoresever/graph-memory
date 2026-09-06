/**
 * graph-memory-pro — 柔性衰减（三因子加权评分 + tier 双向转换）
 *
 * 完整公式、字段映射、默认值来源、调参指南见 docs/decay.md。
 * 评分 / tier 决策 / applyDecay 的入口均在本文件。
 *
 * 调用时机：runMaintenance 的第 0 步（去重/PageRank/社区之前）。
 * decay 调整 tier；另承担两阶段生命周期的阶段一（autoDeprecate，见 shouldAutoDeprecate）：
 * 长期未被访问的 peripheral 低分节点被自动断联 + deprecated（deprecatedBy='decay'），
 * 阶段二（purge 到期硬删）在 maintenance.ts 里调用 store.purgeDeprecatedNodes。
 */

import type { Driver } from "neo4j-driver";
import type { GmConfig, DecayConfig, GmNode, NodeTier } from "../types.ts";
import { getSession } from "../store/db.ts";
import { allActiveNodes, autoDeprecateNodes } from "../store/store.ts";

const MS_PER_DAY = 86_400_000;

export interface CompositeScore {
  composite: number;
  recency: number;
  frequency: number;
  intrinsic: number;
}

export interface TierTransition {
  coreToWorking: number;
  workingToPeripheral: number;
  peripheralToWorking: number;
  workingToCore: number;
}

export interface DecayResult {
  enabled: boolean;
  scanned: number;
  tierTransitions: TierTransition;
  /** 本次维护中被遗忘曲线自动弃用（断联 + deprecated）的节点数。 */
  autoDeprecated: number;
  /** 自动弃用批量写失败时的错误（fail-soft，不否定评分/tier 步骤）。 */
  autoDeprecateError?: string;
  durationMs: number;
}

// ─── 归一化辅助（纯函数，便于单元测试） ──────────────────────

/** importance ∈ [0,1]：当前批次的 pagerank 归一化值。 */
export function normalizeImportance(pagerank: number, maxPagerank: number): number {
  if (maxPagerank <= 0) return 0;
  return Math.min(1, Math.max(0, pagerank / maxPagerank));
}

/** confidence ∈ [0,1)：validatedCount 越高越可信，饱和收敛到 1。 */
export function computeConfidence(validatedCount: number): number {
  const c = Math.max(0, validatedCount);
  return 1 - 1 / (1 + c);
}

// ─── 三因子评分（纯函数） ────────────────────────────────────

/** 选 lastAccessedAt → updatedAt → createdAt 中第一个 > 0 的，用于回退旧节点缺字段。 */
function pickLastActive(node: Pick<GmNode, "lastAccessedAt" | "updatedAt" | "createdAt">): number {
  const la = node.lastAccessedAt ?? 0;
  const up = node.updatedAt ?? 0;
  if (la > 0) return la;
  if (up > 0) return up;
  return node.createdAt ?? 0;
}

/** β 随 tier 变化：core 缓衰、peripheral 促衰。 */
export function computeBeta(tier: NodeTier, cfg: DecayConfig): number {
  switch (tier) {
    case "core": return cfg.betaCore;
    case "working": return cfg.betaWorking;
    case "peripheral": return cfg.betaPeripheral;
  }
}

/**
 * Recency 分量：Weibull 拉伸指数衰减。
 * tier 决定 β；importance 调制半衰期（高重要性 → 慢衰减）。
 */
export function scoreRecency(
  node: Pick<GmNode, "lastAccessedAt" | "updatedAt" | "createdAt" | "tier">,
  importance: number,
  now: number,
  cfg: DecayConfig,
): number {
  const lastActive = pickLastActive(node);
  const daysSince = Math.max(0, (now - lastActive) / MS_PER_DAY);

  const effectiveHL = cfg.recencyHalfLifeDays * Math.exp(cfg.importanceModulation * importance);
  const lambda = Math.LN2 / effectiveHL;
  const beta = computeBeta(node.tier ?? "working", cfg);

  return Math.exp(-lambda * Math.pow(daysSince, beta));
}

/**
 * Frequency 分量：基础饱和项 × 平均访问间隔新鲜度。
 * validatedCount ≤ 1 时只返回基础项（无法算平均间隔）。
 */
export function scoreFrequency(
  node: Pick<GmNode, "validatedCount" | "lastAccessedAt" | "updatedAt" | "createdAt">,
): number {
  const count = Math.max(0, node.validatedCount);
  const base = 1 - Math.exp(-count / 5);
  if (count <= 1) return base;

  const lastActive = pickLastActive(node);
  const accessSpanDays = Math.max(1, (lastActive - node.createdAt) / MS_PER_DAY);
  const avgGapDays = accessSpanDays / Math.max(count - 1, 1);
  const recentnessBonus = Math.exp(-avgGapDays / 30);

  return base * (0.5 + 0.5 * recentnessBonus);
}

/** Intrinsic 分量：importance × confidence。 */
export function scoreIntrinsic(importance: number, confidence: number): number {
  return importance * confidence;
}

/** 三因子加权汇总。权重和在运行时归一化到 1，避免用户配置偏差导致 composite > 1。 */
export function scoreNode(
  node: Pick<GmNode,
    "lastAccessedAt" | "updatedAt" | "createdAt" | "tier"
    | "validatedCount" | "pagerank">,
  maxPagerank: number,
  now: number,
  cfg: DecayConfig,
): CompositeScore {
  const importance = normalizeImportance(node.pagerank, maxPagerank);
  const confidence = computeConfidence(node.validatedCount);
  const recency = scoreRecency(node, importance, now, cfg);
  const frequency = scoreFrequency(node);
  const intrinsic = scoreIntrinsic(importance, confidence);

  const wSum = cfg.recencyWeight + cfg.frequencyWeight + cfg.intrinsicWeight;
  const safeSum = wSum > 0 ? wSum : 1;
  const wR = cfg.recencyWeight / safeSum;
  const wF = cfg.frequencyWeight / safeSum;
  const wI = cfg.intrinsicWeight / safeSum;

  const composite = wR * recency + wF * frequency + wI * intrinsic;

  return { composite, recency, frequency, intrinsic };
}

// ─── Tier 转换决策（纯函数） ─────────────────────────────────

/**
 * 决定节点的下一个 tier。返回 null 表示保持不变。
 * importance 已归一化（调用方须先 normalizeImportance）。
 */
export function decideTierTransition(
  node: Pick<GmNode, "tier" | "validatedCount" | "createdAt">,
  score: CompositeScore,
  importance: number,
  cfg: DecayConfig,
  now: number = Date.now(),
): NodeTier | null {
  const current = node.tier ?? "working";
  const count = node.validatedCount;
  const ageDays = Math.max(0, (now - node.createdAt) / MS_PER_DAY);
  const composite = score.composite;

  if (current === "core"
    && composite < cfg.peripheralCompositeThreshold
    && count < cfg.workingAccessThreshold) {
    return "working";
  }

  if (current === "working") {
    if (composite < cfg.peripheralCompositeThreshold) return "peripheral";
    if (ageDays > cfg.peripheralAgeDays && count < cfg.workingAccessThreshold) {
      return "peripheral";
    }
  }

  if (current === "peripheral"
    && count >= cfg.workingAccessThreshold
    && composite >= cfg.workingCompositeThreshold) {
    return "working";
  }

  if (current === "working"
    && count >= cfg.coreAccessThreshold
    && composite >= cfg.coreCompositeThreshold
    && importance >= cfg.coreImportanceThreshold) {
    return "core";
  }

  return null;
}

// ─── 遗忘曲线自动弃用决策（纯函数，两阶段生命周期·阶段一） ───

/**
 * 判断节点是否应被自动弃用（断联 + status='deprecated'，deprecatedBy='decay'）。
 * 三个条件同时满足（复用遗忘曲线判定，tier 转换先行）：
 * 1. 已降至 peripheral 层（遗忘曲线认为不再活跃）；
 * 2. composite 仍低于 peripheralCompositeThreshold（高价值节点受 intrinsic 保护）；
 * 3. 距最近访问（lastAccessedAt → updatedAt → createdAt 回退链）≥ autoDeprecateAfterDays。
 * autoDeprecate=false 时恒 false。硬删（阶段二）不在此判定，见 store.purgeDeprecatedNodes。
 */
export function shouldAutoDeprecate(
  node: Pick<GmNode, "tier" | "lastAccessedAt" | "updatedAt" | "createdAt">,
  score: CompositeScore,
  cfg: DecayConfig,
  now: number = Date.now(),
): boolean {
  if (!cfg.autoDeprecate) return false;
  if ((node.tier ?? "working") !== "peripheral") return false;
  if (score.composite >= cfg.peripheralCompositeThreshold) return false;
  const lastActive = pickLastActive(node);
  const daysSince = Math.max(0, (now - lastActive) / MS_PER_DAY);
  return daysSince >= cfg.autoDeprecateAfterDays;
}

// ─── 应用层：扫描 + 评分 + 转换 ──────────────────────────────

const EMPTY_TRANSITIONS: TierTransition = {
  coreToWorking: 0,
  workingToPeripheral: 0,
  peripheralToWorking: 0,
  workingToCore: 0,
};

function bumpTransition(transitions: TierTransition, from: NodeTier, to: NodeTier): void {
  if (from === "core" && to === "working") transitions.coreToWorking++;
  else if (from === "working" && to === "peripheral") transitions.workingToPeripheral++;
  else if (from === "peripheral" && to === "working") transitions.peripheralToWorking++;
  else if (from === "working" && to === "core") transitions.workingToCore++;
}

/**
 * 扫描所有 active 节点：评分 + tier 转换 + 写回 decayScore / tier；
 * autoDeprecate 开启时，对同时满足 shouldAutoDeprecate 的节点执行阶段一自动弃用
 * （断联 + deprecated，deprecatedBy='decay'，可被重新提取/编辑复活）。
 */
export async function applyDecay(driver: Driver, cfg: Pick<GmConfig, "decay">): Promise<DecayResult> {
  const start = Date.now();
  const d = cfg.decay;
  if (!d?.enabled) {
    return { enabled: false, scanned: 0, tierTransitions: { ...EMPTY_TRANSITIONS }, autoDeprecated: 0, durationMs: 0 };
  }

  const nodes = await allActiveNodes(driver);
  if (nodes.length === 0) {
    return { enabled: true, scanned: 0, tierTransitions: { ...EMPTY_TRANSITIONS }, autoDeprecated: 0, durationMs: 0 };
  }

  // reduce 而非 Math.max(...map)：spread 在超大节点集（>10 万）会爆调用栈
  const maxPagerank = nodes.reduce((m, n) => Math.max(m, n.pagerank), 0.0001);

  const updates: Array<{ id: string; tier: NodeTier; composite: number; tierChanged: boolean }> = [];
  const autoDeprecateIds: string[] = [];
  const transitions: TierTransition = { ...EMPTY_TRANSITIONS };

  for (const node of nodes) {
    const score = scoreNode(node, maxPagerank, start, d);
    const importance = normalizeImportance(node.pagerank, maxPagerank);
    const currentTier = node.tier ?? "working";
    const nextTier = decideTierTransition(node, score, importance, d, start);
    const finalTier = nextTier ?? currentTier;
    const tierChanged = nextTier !== null;

    if (tierChanged) bumpTransition(transitions, currentTier, finalTier);

    // 用 tier 转换后的层级判定：本轮刚降到 peripheral 的老节点即刻参与阶段一
    if (shouldAutoDeprecate({ ...node, tier: finalTier }, score, d, start)) {
      autoDeprecateIds.push(node.id);
    }

    updates.push({
      id: node.id,
      tier: finalTier,
      composite: score.composite,
      tierChanged,
    });
  }

  if (updates.length > 0) {
    const session = getSession(driver);
    try {
      await session.run(
        `UNWIND $updates AS u
         MATCH (n:Task|Skill|Event {id: u.id})
         SET n.tier = u.tier,
             n.decayScore = u.composite,
             n.decayComputedAt = $now,
             n.updatedAt = CASE WHEN u.tierChanged THEN $now ELSE n.updatedAt END`,
        { updates, now: start },
      );
    } finally {
      await session.close();
    }
  }

  // 阶段一自动弃用：断联 + deprecated + [DEPRECATED] 前缀。
  // fail-soft：错误记入结果由调用方记日志，不阻塞维护链其余步骤，下一周期重试。
  let autoDeprecated = 0;
  let autoDeprecateError: string | undefined;
  if (autoDeprecateIds.length > 0) {
    try {
      autoDeprecated = await autoDeprecateNodes(driver, autoDeprecateIds, start);
    } catch (err) {
      autoDeprecateError = String(err);
    }
  }

  return {
    enabled: true,
    scanned: nodes.length,
    tierTransitions: transitions,
    autoDeprecated,
    ...(autoDeprecateError ? { autoDeprecateError } : {}),
    durationMs: Date.now() - start,
  };
}
