/**
 * graph-memory-pro — 原始消息有界保留（opt-in）
 *
 * 移植自上游 #96（SQLite → Neo4j Cypher）。设计原则不变：
 * "上下文压缩改变的是模型可见面，不构成删除持久证据的授权。"
 *
 *   - 默认 keep=all：不做任何删除，本模块在维护链中零开销直返。
 *   - referenced：只删"已提取完成且实际产出知识"的消息（extracted=true 且
 *     producedKnowledge=true）—— 知识已固化进图谱节点/边，原始文本退役。
 *     LLM 空提取（零节点零边）的轮次标记 producedKnowledge=false，原始证据
 *     保留；重挖需手动重置 extracted 后跑 graph-memory extract。
 *   - recent：referenced 之上叠加时间窗保护（每 session 最近 N 轮真实用户发言
 *     及其后消息、最近 N 天内入库的消息），验证时要求至少配置一个窗口参数。
 *
 * 与上游的差异：v2.0 schema 没有消息级出处边（节点仅记 sourceSessions，
 * 粒度为 session），上游 "无 gm_node_sources 引用" 的前置条件在这里等价于
 * extracted=true AND producedKnowledge=true。遗留行（producedKnowledge 属性
 * 缺失，标记机制上线前已提取）fail-closed 不删。DELETE 前按同条件重新校验，
 * 防止候选查询与删除语义未来漂移 —— 候选集不能成为删除的授权。
 */

import { createHash } from "node:crypto";
import { int } from "neo4j-driver";
import type { Driver } from "neo4j-driver";
import { getSession } from "./db.ts";
import type { MessageRetentionConfig } from "../types.ts";

export type NormalizedMessageRetentionPolicy = Required<MessageRetentionConfig>;

export interface MessageRetentionResult {
  policy: string;
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
  sessionId: string;
  role: string;
  createdAt: number;
  contentBytes: number;
}

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

/** 配置校验。非法策略 fail closed（抛错 → 不删任何东西）；register 时提前验证以给出友好报错。 */
export function normalizeMessageRetentionPolicy(
  input: MessageRetentionConfig | undefined,
): NormalizedMessageRetentionPolicy {
  if (input === undefined) return { keep: "all", recentTurns: 0, retentionDays: 0, batchSize: 500, dryRun: false };
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

function emptyResult(policy: NormalizedMessageRetentionPolicy, cutoffAt: number, start: number): MessageRetentionResult {
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

/**
 * 构造候选查询。
 *
 * recentTurns 保护：以 session 内最近 N 条 user 消息里最旧一条的 turnIndex 为界，
 * 只候选更早的消息（该轮的 assistant/tool 消息随所属轮次保留）；
 * 没有任何 user 消息的 session 完全保护 —— 与上游 LEFT JOIN 的 NULL 语义一致。
 * createdAt 缺失/为零/为负/超前一律 fail closed（不进候选）。
 */
function buildCandidateQuery(
  policy: NormalizedMessageRetentionPolicy,
  now: number,
): { cypher: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = {
    // JS number 会以 Float 发送 —— LIMIT 与列表下标要求整数，必须用 neo4j int()
    recentTurns: int(policy.recentTurns),
    batchLimit: int(policy.batchSize + 1),
  };

  let match = "MATCH (m:GmMessage)\nWHERE m.extracted = true AND m.producedKnowledge = true\n";
  if (policy.recentTurns > 0) {
    match =
      "MATCH (u:GmMessage {role: 'user'})\n" +
      "WITH u.sessionId AS sid, u ORDER BY sid, u.turnIndex DESC\n" +
      "WITH sid, collect(u.turnIndex) AS turns\n" +
      "WITH sid, CASE WHEN size(turns) >= $recentTurns THEN turns[$recentTurns - 1] ELSE -1 END AS cutoffTurn\n" +
      "MATCH (m:GmMessage {sessionId: sid})\n" +
      "WHERE m.extracted = true AND m.producedKnowledge = true\n" +
      "  AND m.turnIndex < cutoffTurn\n";
  }
  if (policy.retentionDays > 0) {
    params.ageCutoff = now - policy.retentionDays * 86_400_000;
    match += "  AND m.createdAt > 0 AND m.createdAt < $ageCutoff\n";
  }

  const cypher =
    match +
    "WITH m ORDER BY m.createdAt, m.sessionId, m.turnIndex\n" +
    "LIMIT $batchLimit\n" +
    "RETURN m.id AS id, m.sessionId AS sessionId, m.role AS role, " +
    "m.createdAt AS createdAt, size(m.content) AS contentBytes";
  return { cypher, params };
}

/**
 * 跑一个有界批次。候选选择与删除放在同一个写事务里冻结边界；
 * 删除前按 extracted + producedKnowledge 重新校验（候选查询不是删除的授权）。
 * size(m.content) 返回字符数（近似体积），与上游 BLOB 字节数略有差异，仅用于统计。
 */
export async function runMessageRetention(
  driver: Driver,
  policy: NormalizedMessageRetentionPolicy,
  now: number = Date.now(),
): Promise<MessageRetentionResult> {
  const start = Date.now();
  if (policy.keep === "all") return emptyResult(policy, now, start);

  const { cypher, params } = buildCandidateQuery(policy, now);

  const session = getSession(driver);
  try {
    const { rows, deletedRows, hasMore } = await session.executeWrite(async (tx) => {
      const candRes = await tx.run(cypher, params);
      const rows: CandidateRow[] = candRes.records.map((r) => ({
        id: r.get("id"),
        sessionId: r.get("sessionId"),
        role: r.get("role"),
        createdAt: Number(r.get("createdAt")),
        contentBytes: Number(r.get("contentBytes")),
      }));

      let hasMore = false;
      if (rows.length > policy.batchSize) {
        hasMore = true;
        rows.pop();
      }

      let deletedRows = 0;
      if (!policy.dryRun && rows.length) {
        const delRes = await tx.run(
          "UNWIND $ids AS mid " +
          "MATCH (m:GmMessage {id: mid}) " +
          "WHERE m.extracted = true AND m.producedKnowledge = true " +
          "DETACH DELETE m " +
          "RETURN count(m) AS deleted",
          { ids: rows.map((r) => r.id) },
        );
        deletedRows = delRes.records[0]?.get("deleted").toNumber() ?? 0;
      }
      return { rows, deletedRows, hasMore };
    });

    const selectedBytes = rows.reduce((total, r) => total + r.contentBytes, 0);
    const byRole: Record<string, number> = {};
    for (const r of rows) byRole[r.role] = (byRole[r.role] ?? 0) + 1;
    const created = rows.map((r) => r.createdAt).filter(Number.isFinite);

    return {
      policy: policy.keep,
      policyRevision: messageRetentionPolicyRevision(policy),
      dryRun: policy.dryRun,
      selectedRows: rows.length,
      selectedBytes,
      deletedRows,
      deletedBytes: deletedRows === rows.length ? selectedBytes : 0,
      selectedSessions: new Set(rows.map((r) => r.sessionId)).size,
      byRole,
      oldestCreatedAt: created.length ? Math.min(...created) : null,
      newestCreatedAt: created.length ? Math.max(...created) : null,
      hasMore,
      cutoffAt: now,
      durationMs: Date.now() - start,
    };
  } finally {
    await session.close();
  }
}
