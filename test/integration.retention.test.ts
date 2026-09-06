import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Driver } from "neo4j-driver";
import { getDriver, initSchema, closeDriver, getSession } from "../src/store/db.ts";
import { saveMessage, markExtracted } from "../src/store/store.ts";
import { normalizeMessageRetentionPolicy, runMessageRetention } from "../src/store/retention.ts";

// 仅在显式提供 NEO4J_TEST_URI 时运行（需要 Docker Neo4j，CI 执行）。
// 刻意不默认 bolt://localhost:7687：本测试会删除数据，绝不允许
// 因缺省值静默落到可能是真实数据库的端口上。
const NEO4J_URI = process.env.NEO4J_TEST_URI;
const ENABLED = !!process.env.NEO4J_INTEGRATION && !!NEO4J_URI;
const TEST_PREFIX = "retention-";

let driver: Driver;
const SID_A = `retention-a-${Date.now()}`; // referenced 场景：前半提取、后半未提取
const SID_B = `retention-b-${Date.now()}`; // recentTurns 场景：全部提取
const SID_C = `retention-c-${Date.now()}`; // retentionDays 场景：无 user 消息（recentTurns 下全保护）
const SID_D = `retention-d-${Date.now()}`; // 无 user 消息的 session
const SID_E = `retention-e-${Date.now()}`; // 空提取：extracted=true 但 producedKnowledge=false
const SID_F = `retention-f-${Date.now()}`; // 遗留行：直接 SET extracted=true，无 producedKnowledge 属性
const DAY = 86_400_000;

async function seedSession(sid: string, turns: number, roles: (t: number) => string): Promise<void> {
  for (let t = 0; t < turns; t++) {
    await saveMessage(driver, sid, t, roles(t), { text: `msg-${sid}-${t}` });
  }
}

async function survivingTurns(sid: string): Promise<number[]> {
  const session = getSession(driver);
  try {
    const res = await session.run(
      "MATCH (m:GmMessage {sessionId: $sid}) RETURN m.turnIndex AS t ORDER BY t",
      { sid },
    );
    return res.records.map((r) => Number(r.get("t")));
  } finally {
    await session.close();
  }
}

async function setCreatedAt(sid: string, turn: number, ts: number): Promise<void> {
  const session = getSession(driver);
  try {
    await session.run(
      "MATCH (m:GmMessage {sessionId: $sid, turnIndex: $turn}) SET m.createdAt = $ts",
      { sid, turn, ts },
    );
  } finally {
    await session.close();
  }
}

/** 模拟 producedKnowledge 标记机制上线前的遗留行：直接 SET extracted=true。 */
async function setExtractedLegacy(sid: string): Promise<void> {
  const session = getSession(driver);
  try {
    await session.run(
      "MATCH (m:GmMessage {sessionId: $sid}) SET m.extracted = true",
      { sid },
    );
  } finally {
    await session.close();
  }
}

describe.skipIf(!ENABLED)("GmMessage retention (Docker)", () => {
  beforeAll(async () => {
    driver = getDriver({ uri: NEO4J_URI!, user: "neo4j", password: "graphmemory" });
    await initSchema(driver);

    // 隔离守卫：库内存在任何非本测试前缀的 GmMessage 即中止 ——
    // 这是删除类测试，绝不能在有真实数据的库上执行
    const guard = getSession(driver);
    try {
      const res = await guard.run(
        "MATCH (m:GmMessage) WHERE NOT m.sessionId STARTS WITH $prefix RETURN count(m) AS n",
        { prefix: TEST_PREFIX },
      );
      const foreign = res.records[0].get("n").toNumber();
      if (foreign > 0) {
        throw new Error(
          `[retention-test] 目标数据库含 ${foreign} 条非测试前缀消息，疑似真实数据库 —— 拒绝运行。` +
          `请确认 NEO4J_TEST_URI 指向一次性测试实例。`,
        );
      }
      // 清理历史残留（前次中断的运行），保证候选集可预测
      await guard.run(
        "MATCH (m:GmMessage) WHERE m.sessionId STARTS WITH $prefix DETACH DELETE m",
        { prefix: TEST_PREFIX },
      );
    } finally {
      await guard.close();
    }

    // A：10 条（偶数轮 user / 奇数轮 assistant），turns 0-5 已提取，6-9 未提取
    await seedSession(SID_A, 10, (t) => (t % 2 === 0 ? "user" : "assistant"));
    await markExtracted(driver, SID_A, 5);
    // B：10 条全部提取，角色同 A（user 轮 0/2/4/6/8）
    await seedSession(SID_B, 10, (t) => (t % 2 === 0 ? "user" : "assistant"));
    await markExtracted(driver, SID_B, 9);
    // C：4 条全部 assistant（无 user 消息）、全部提取；turns 0/1 一百天前，2/3 昨天
    await seedSession(SID_C, 4, () => "assistant");
    await markExtracted(driver, SID_C, 3);
    await setCreatedAt(SID_C, 0, Date.now() - 100 * DAY);
    await setCreatedAt(SID_C, 1, Date.now() - 100 * DAY);
    await setCreatedAt(SID_C, 2, Date.now() - 1 * DAY);
    await setCreatedAt(SID_C, 3, Date.now() - 1 * DAY);
    // D：2 条 assistant、全部提取、无 user 消息
    await seedSession(SID_D, 2, () => "assistant");
    await markExtracted(driver, SID_D, 1);
    // E：4 条空提取 —— LLM 成功返回零节点零边：extracted=true, producedKnowledge=false
    await seedSession(SID_E, 4, () => "assistant");
    await markExtracted(driver, SID_E, 3, false);
    // F：遗留行（标记机制上线前已提取）：无 producedKnowledge 属性
    await seedSession(SID_F, 2, () => "assistant");
    await setExtractedLegacy(SID_F);
  });

  afterAll(async () => {
    const s = getSession(driver);
    try {
      await s.run(
        "MATCH (m:GmMessage) WHERE m.sessionId STARTS WITH $prefix DETACH DELETE m",
        { prefix: TEST_PREFIX },
      );
    } finally {
      await s.close();
    }
    await closeDriver();
  });

  it("keep=all is a no-op that never touches the database", async () => {
    const policy = normalizeMessageRetentionPolicy({ keep: "all" });
    const result = await runMessageRetention(driver, policy);
    expect(result.selectedRows).toBe(0);
    expect(result.deletedRows).toBe(0);
    expect(await survivingTurns(SID_A)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("retentionDays window only removes extracted messages older than the cutoff", async () => {
    const policy = normalizeMessageRetentionPolicy({ keep: "recent", retentionDays: 30 });
    const result = await runMessageRetention(driver, policy);

    expect(result.policy).toBe("recent");
    expect(result.deletedRows).toBeGreaterThanOrEqual(2); // 至少 C 的 turns 0/1
    // C：只有一百天前的 turns 0/1 被删，昨天的 2/3 保留
    expect(await survivingTurns(SID_C)).toEqual([2, 3]);
    // A/B/D 全部保留（createdAt 都是新写入的）
    expect(await survivingTurns(SID_A)).toHaveLength(10);
    expect(await survivingTurns(SID_B)).toHaveLength(10);
    expect(await survivingTurns(SID_D)).toHaveLength(2);
  });

  it("recentTurns window protects the newest user turns and unextracted messages", async () => {
    const policy = normalizeMessageRetentionPolicy({ keep: "recent", recentTurns: 2 });
    const result = await runMessageRetention(driver, policy);

    // cutoff = 第 2 新 user 轮的 turnIndex（user 轮 0/2/4/6/8 → cutoff=6），该轮及其后保留
    expect(result.deletedRows).toBeGreaterThanOrEqual(12); // A/B 各删 turns 0-5
    // A：turns 0-5（已提取、窗口外）删；6-9 留（6/8 在窗口内，7/9 未提取）
    expect(await survivingTurns(SID_A)).toEqual([6, 7, 8, 9]);
    // B：同结构全提取，turns 0-5 删、6-9 留
    expect(await survivingTurns(SID_B)).toEqual([6, 7, 8, 9]);
    // C/D 没有 user 消息 → 完全保护（与上游 NULL cutoff 语义一致）
    expect(await survivingTurns(SID_C)).toEqual([2, 3]);
    expect(await survivingTurns(SID_D)).toEqual([0, 1]);
  });

  it("dryRun reports candidates without deleting", async () => {
    const policy = normalizeMessageRetentionPolicy({ keep: "referenced", dryRun: true });
    const result = await runMessageRetention(driver, policy);

    expect(result.dryRun).toBe(true);
    expect(result.deletedRows).toBe(0);
    // 候选 = 剩余全部 producedKnowledge=true：B(6-9) + C(2,3) + D(0,1) = 8
    // （E 空提取 pk=false、F 遗留行无属性 —— 均不进候选）
    expect(result.selectedRows).toBe(8);
    expect(await survivingTurns(SID_A)).toEqual([6, 7, 8, 9]);
    expect(await survivingTurns(SID_B)).toEqual([6, 7, 8, 9]);
  });

  it("keep=referenced removes remaining extracted messages and never unextracted ones", async () => {
    const policy = normalizeMessageRetentionPolicy({ keep: "referenced" });
    const result = await runMessageRetention(driver, policy);

    expect(result.deletedRows).toBe(8);
    // A 只剩未提取的 turns 6-9 —— 未提取消息永远不进候选
    expect(await survivingTurns(SID_A)).toEqual([6, 7, 8, 9]);
    expect(await survivingTurns(SID_B)).toEqual([]);
    expect(await survivingTurns(SID_C)).toEqual([]);
    expect(await survivingTurns(SID_D)).toEqual([]);
  });

  it("keeps empty-extraction turns and legacy rows (producedKnowledge gate)", async () => {
    const policy = normalizeMessageRetentionPolicy({ keep: "referenced" });
    const result = await runMessageRetention(driver, policy);

    // E：空提取（extracted=true, producedKnowledge=false）—— 原始证据保留，
    // 日后换更好的 prompt/模型仍可回捞
    expect(await survivingTurns(SID_E)).toEqual([0, 1, 2, 3]);
    // F：遗留行（无 producedKnowledge 属性）—— fail-closed 不删
    expect(await survivingTurns(SID_F)).toEqual([0, 1]);
    // 上一测试已清空全部 producedKnowledge=true 候选，本轮零删除
    expect(result.selectedRows).toBe(0);
    expect(result.deletedRows).toBe(0);
  });

  it("reports per-role stats and session spread", async () => {
    // 上一测试后 A 仅剩 turns 6-9（user 6/8, assistant 7/9）——再跑一轮 referenced 空转
    const policy = normalizeMessageRetentionPolicy({ keep: "referenced" });
    const result = await runMessageRetention(driver, policy);
    expect(result.selectedRows).toBeGreaterThanOrEqual(0);
    expect(result.cutoffAt).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.policyRevision).toMatch(/^[0-9a-f]{12}$/);
  });

  it("batches deletion and reports hasMore when candidates exceed batchSize", async () => {
    // 专用 session：6 条全部提取、无 user 消息（referenced 下全部可候选）
    const sid = `retention-batch-${Date.now()}`;
    await seedSession(sid, 6, () => "assistant");
    await markExtracted(driver, sid, 5);

    // batchSize=2：一个维护周期只处理最旧的 2 条，hasMore=true 提示还有剩余
    const policy = normalizeMessageRetentionPolicy({ keep: "referenced", batchSize: 2 });
    const result = await runMessageRetention(driver, policy);

    expect(result.selectedRows).toBe(2);
    expect(result.deletedRows).toBe(2);
    expect(result.hasMore).toBe(true);
    expect(await survivingTurns(sid)).toEqual([2, 3, 4, 5]);
  });
});
