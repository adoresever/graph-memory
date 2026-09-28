/**
 * Durable raw-message retention for host adapters.
 *
 * Context compaction changes the model surface; it is not permission to
 * delete durable evidence. This module therefore defaults to keep=all and
 * only prunes rows that are extracted and unreferenced by graph provenance.
 */
import { createHash } from "node:crypto";
import type { DatabaseSyncInstance } from "./sqlite.ts";

export type MessageRetentionMode = "all" | "referenced" | "recent";

export interface MessageRetentionConfig {
  /** all keeps every raw row; referenced/recent opt in to bounded pruning. */
  keep?: MessageRetentionMode;
  /** Preserve this many newest real user turns in every session. */
  recentTurns?: number;
  /** Preserve rows ingested within this many days. */
  retentionDays?: number;
  /** Maximum rows considered by one maintenance tick. */
  batchSize?: number;
  /** Report candidates without deleting them. */
  dryRun?: boolean;
}

export interface NormalizedMessageRetentionPolicy {
  keep: MessageRetentionMode;
  recentTurns: number;
  retentionDays: number;
  batchSize: number;
  dryRun: boolean;
}

export interface MessageRetentionResult {
  policy: MessageRetentionMode;
  policyRevision: string;
  dryRun: boolean;
  selectedRows: number;
  selectedBytes: number;
  deletedRows: number;
  deletedBytes: number;
  selectedSessions: number;
  byRole: Record<string, number>;
  oldestCreatedAt: number | null;
  newestCreatedAt: number | null;
  hasMore: boolean;
  cutoffAt: number;
  durationMs: number;
}

interface CandidateRow {
  id: string;
  session_id: string;
  role: string;
  created_at: number;
  content_bytes: number;
}

export const DEFAULT_MESSAGE_RETENTION: Readonly<NormalizedMessageRetentionPolicy> = Object.freeze({
  keep: "all",
  recentTurns: 0,
  retentionDays: 0,
  batchSize: 500,
  dryRun: false,
});

function boundedInteger(
  value: unknown,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new TypeError(
      `[graph-memory] messageRetention.${name} must be an integer between ${minimum} and ${maximum}, received ${String(value)}`,
    );
  }
  return Number(value);
}

/** Validate once before opening the database. Invalid policies fail closed. */
export function normalizeMessageRetentionPolicy(
  input: MessageRetentionConfig | undefined,
): NormalizedMessageRetentionPolicy {
  if (input === undefined) return { ...DEFAULT_MESSAGE_RETENTION };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("[graph-memory] messageRetention must be an object");
  }

  const keep = input.keep ?? "all";
  if (keep !== "all" && keep !== "referenced" && keep !== "recent") {
    throw new TypeError(
      `[graph-memory] messageRetention.keep must be all, referenced, or recent, received ${String(keep)}`,
    );
  }
  const recentTurns = boundedInteger(input.recentTurns, "recentTurns", 0, 0, 100_000);
  const retentionDays = boundedInteger(input.retentionDays, "retentionDays", 0, 0, 36_500);
  const batchSize = boundedInteger(input.batchSize, "batchSize", 500, 1, 10_000);
  const dryRun = input.dryRun ?? false;
  if (typeof dryRun !== "boolean") {
    throw new TypeError(
      `[graph-memory] messageRetention.dryRun must be a boolean, received ${String(dryRun)}`,
    );
  }
  if (keep === "recent" && recentTurns === 0 && retentionDays === 0) {
    throw new TypeError(
      "[graph-memory] messageRetention.keep=recent requires recentTurns or retentionDays",
    );
  }

  return { keep, recentTurns, retentionDays, batchSize, dryRun };
}

export function messageRetentionPolicyRevision(
  policy: NormalizedMessageRetentionPolicy,
): string {
  return createHash("sha256")
    .update(JSON.stringify(policy))
    .digest("hex")
    .slice(0, 12);
}

function emptyResult(
  policy: NormalizedMessageRetentionPolicy,
  cutoffAt: number,
  start: number,
): MessageRetentionResult {
  return {
    policy: policy.keep,
    policyRevision: messageRetentionPolicyRevision(policy),
    dryRun: policy.dryRun,
    selectedRows: 0,
    selectedBytes: 0,
    deletedRows: 0,
    deletedBytes: 0,
    selectedSessions: 0,
    byRole: {},
    oldestCreatedAt: null,
    newestCreatedAt: null,
    hasMore: false,
    cutoffAt,
    durationMs: Date.now() - start,
  };
}

function selectCandidates(
  db: DatabaseSyncInstance,
  policy: NormalizedMessageRetentionPolicy,
  cutoffAt: number,
): { rows: CandidateRow[]; hasMore: boolean } {
  const params: Array<number> = [];
  let recentJoin = "";
  let recentClause = "";
  if (policy.recentTurns > 0) {
    recentJoin = `
      LEFT JOIN (
        SELECT session_id, MIN(turn_index) AS cutoff_turn
        FROM (
          SELECT session_id, turn_index,
            ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY turn_index DESC) AS user_rank
          FROM gm_messages
          WHERE role='user'
        ) ranked_users
        WHERE user_rank <= ?
        GROUP BY session_id
      ) recent ON recent.session_id=m.session_id
    `;
    recentClause = "AND recent.cutoff_turn IS NOT NULL AND m.turn_index < recent.cutoff_turn";
    params.push(policy.recentTurns);
  }

  let ageClause = "";
  if (policy.retentionDays > 0) {
    const ageCutoff = cutoffAt - policy.retentionDays * 86_400_000;
    // Missing, zero, negative and future timestamps fail closed to retention.
    ageClause = "AND m.created_at > 0 AND m.created_at < ?";
    params.push(ageCutoff);
  }

  params.push(policy.batchSize + 1);
  const rows = db.prepare(`
    SELECT m.id, m.session_id, m.role, m.created_at,
      length(CAST(m.content AS BLOB)) AS content_bytes
    FROM gm_messages m
    ${recentJoin}
    WHERE m.extracted=1 AND m.extraction_state='succeeded'
      AND NOT EXISTS (
        SELECT 1 FROM gm_node_sources source WHERE source.message_id=m.id
      )
      ${recentClause}
      ${ageClause}
    ORDER BY m.created_at, m.session_id, m.turn_index, m.id
    LIMIT ?
  `).all(...params) as unknown as CandidateRow[];

  const hasMore = rows.length > policy.batchSize;
  if (hasMore) rows.pop();
  return { rows, hasMore };
}

/**
 * Run one bounded retention batch.
 *
 * A write-intent transaction freezes the candidate/reference boundary across
 * connections. The DELETE still re-checks extracted state and provenance so
 * a future refactor cannot silently turn candidate selection into authority.
 * VACUUM is intentionally separate: deleting rows is the policy operation;
 * rewriting the whole database file is an explicit administrative choice.
 */
export function runMessageRetention(
  db: DatabaseSyncInstance,
  policy: NormalizedMessageRetentionPolicy,
  now: number = Date.now(),
): MessageRetentionResult {
  const start = Date.now();
  if (policy.keep === "all") return emptyResult(policy, now, start);

  db.exec(policy.dryRun ? "BEGIN" : "BEGIN IMMEDIATE");
  try {
    const { rows, hasMore } = selectCandidates(db, policy, now);
    const selectedBytes = rows.reduce((total, row) => total + Number(row.content_bytes || 0), 0);
    let deletedRows = 0;

    if (!policy.dryRun && rows.length) {
      const placeholders = rows.map(() => "?").join(",");
      const deleted = db.prepare(`
        DELETE FROM gm_messages
        WHERE id IN (${placeholders})
          AND extracted=1 AND extraction_state='succeeded'
          AND NOT EXISTS (
            SELECT 1 FROM gm_node_sources source WHERE source.message_id=gm_messages.id
          )
      `).run(...rows.map((row) => row.id));
      deletedRows = Number(deleted.changes);
    }

    db.exec("COMMIT");
    const byRole: Record<string, number> = {};
    for (const row of rows) byRole[row.role] = (byRole[row.role] ?? 0) + 1;
    const created = rows.map((row) => Number(row.created_at)).filter(Number.isFinite);
    return {
      policy: policy.keep,
      policyRevision: messageRetentionPolicyRevision(policy),
      dryRun: policy.dryRun,
      selectedRows: rows.length,
      selectedBytes,
      deletedRows,
      deletedBytes: deletedRows === rows.length ? selectedBytes : 0,
      selectedSessions: new Set(rows.map((row) => row.session_id)).size,
      byRole,
      oldestCreatedAt: created.length ? Math.min(...created) : null,
      newestCreatedAt: created.length ? Math.max(...created) : null,
      hasMore,
      cutoffAt: now,
      durationMs: Date.now() - start,
    };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve the original error */ }
    throw error;
  }
}
