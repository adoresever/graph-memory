/**
 * Monthly LLM call budgeting with dynamic daily allowance.
 *
 * CodePlan-style plans are call-count limited. We track monthly usage and
 * compute today's allowance as:
 *
 *   remaining monthly calls / days left in the month, including today
 *
 * This keeps usage close to the monthly limit while allowing quiet days to
 * increase later daily capacity.
 */

import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import type { GmConfig } from "../types.ts";
import { getMeta, setMeta } from "../store/store.ts";

export type LlmCallKind = "extract" | "finalize" | "community_summary" | "other";

export interface BudgetReservation {
  allowed: boolean;
  reason?: string;
  day: string;
  month: string;
  todayUsed: number;
  todayKindUsed: number;
  monthUsed: number;
  monthKindUsed: number;
  todayLimit: number;
  todayKindLimit: number;
  monthlyLimit: number;
  monthlyKindLimit: number;
}

interface DateParts {
  day: string;
  month: string;
  dayOfMonth: number;
  daysInMonth: number;
}

function dateParts(timeZone: string): DateParts {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const year = Number(parts.find(p => p.type === "year")?.value);
    const month = Number(parts.find(p => p.type === "month")?.value);
    const day = Number(parts.find(p => p.type === "day")?.value);
    const daysInMonth = new Date(year, month, 0).getDate();
    const yyyy = String(year).padStart(4, "0");
    const mm = String(month).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    return {
      day: `${yyyy}-${mm}-${dd}`,
      month: `${yyyy}-${mm}`,
      dayOfMonth: day,
      daysInMonth,
    };
  } catch {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const day = now.getUTCDate();
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const yyyy = String(year).padStart(4, "0");
    const mm = String(month).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    return {
      day: `${yyyy}-${mm}-${dd}`,
      month: `${yyyy}-${mm}`,
      dayOfMonth: day,
      daysInMonth,
    };
  }
}

function metaKey(scope: "day" | "month", key: string, kind?: LlmCallKind): string {
  return kind ? `llm_calls:${scope}:${key}:${kind}` : `llm_calls:${scope}:${key}:total`;
}

function readCount(db: DatabaseSyncInstance, key: string): number {
  const raw = getMeta(db, key);
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function monthlyKindLimit(cfg: GmConfig, kind: LlmCallKind): number {
  if (kind === "community_summary") return cfg.llmMonthlyCommunitySummaryBudget;
  if (kind === "finalize") return cfg.llmMonthlyFinalizeBudget;
  return 0;
}

function dynamicDailyLimit(monthlyLimit: number, monthUsed: number, parts: DateParts): number {
  if (monthlyLimit <= 0) return 0;
  const remaining = Math.max(0, monthlyLimit - monthUsed);
  const daysLeft = Math.max(1, parts.daysInMonth - parts.dayOfMonth + 1);
  return Math.ceil(remaining / daysLeft);
}

export function reserveLlmCall(
  db: DatabaseSyncInstance,
  cfg: GmConfig,
  kind: LlmCallKind,
): BudgetReservation {
  const parts = dateParts(cfg.llmBudgetTimeZone || "Asia/Shanghai");
  const monthlyLimit = cfg.llmMonthlyCallBudget;
  const perKindMonthlyLimit = monthlyKindLimit(cfg, kind);

  const dayTotalKey = metaKey("day", parts.day);
  const dayKindKey = metaKey("day", parts.day, kind);
  const monthTotalKey = metaKey("month", parts.month);
  const monthKindKey = metaKey("month", parts.month, kind);

  const todayUsed = readCount(db, dayTotalKey);
  const todayKindUsed = readCount(db, dayKindKey);
  const monthUsed = readCount(db, monthTotalKey);
  const monthKindUsed = readCount(db, monthKindKey);

  const todayLimit = dynamicDailyLimit(monthlyLimit, monthUsed, parts);
  const todayKindLimit = dynamicDailyLimit(perKindMonthlyLimit, monthKindUsed, parts);

  if (monthlyLimit > 0 && monthUsed >= monthlyLimit) {
    return {
      allowed: false,
      reason: "monthly LLM call budget exhausted",
      day: parts.day,
      month: parts.month,
      todayUsed,
      todayKindUsed,
      monthUsed,
      monthKindUsed,
      todayLimit,
      todayKindLimit,
      monthlyLimit,
      monthlyKindLimit: perKindMonthlyLimit,
    };
  }

  if (monthlyLimit > 0 && todayUsed >= todayLimit) {
    return {
      allowed: false,
      reason: "dynamic daily LLM call allowance exhausted",
      day: parts.day,
      month: parts.month,
      todayUsed,
      todayKindUsed,
      monthUsed,
      monthKindUsed,
      todayLimit,
      todayKindLimit,
      monthlyLimit,
      monthlyKindLimit: perKindMonthlyLimit,
    };
  }

  if (perKindMonthlyLimit > 0 && monthKindUsed >= perKindMonthlyLimit) {
    return {
      allowed: false,
      reason: `monthly ${kind} call budget exhausted`,
      day: parts.day,
      month: parts.month,
      todayUsed,
      todayKindUsed,
      monthUsed,
      monthKindUsed,
      todayLimit,
      todayKindLimit,
      monthlyLimit,
      monthlyKindLimit: perKindMonthlyLimit,
    };
  }

  if (perKindMonthlyLimit > 0 && todayKindUsed >= todayKindLimit) {
    return {
      allowed: false,
      reason: `dynamic daily ${kind} call allowance exhausted`,
      day: parts.day,
      month: parts.month,
      todayUsed,
      todayKindUsed,
      monthUsed,
      monthKindUsed,
      todayLimit,
      todayKindLimit,
      monthlyLimit,
      monthlyKindLimit: perKindMonthlyLimit,
    };
  }

  setMeta(db, dayTotalKey, String(todayUsed + 1));
  setMeta(db, dayKindKey, String(todayKindUsed + 1));
  setMeta(db, monthTotalKey, String(monthUsed + 1));
  setMeta(db, monthKindKey, String(monthKindUsed + 1));
  return {
    allowed: true,
    day: parts.day,
    month: parts.month,
    todayUsed: todayUsed + 1,
    todayKindUsed: todayKindUsed + 1,
    monthUsed: monthUsed + 1,
    monthKindUsed: monthKindUsed + 1,
    todayLimit,
    todayKindLimit,
    monthlyLimit,
    monthlyKindLimit: perKindMonthlyLimit,
  };
}
