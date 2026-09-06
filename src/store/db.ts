/**
 * graph-memory-pro — Neo4j 连接管理（加固版）
 *
 * - driver 是长生命周期单例，不在 dispose 时关闭
 * - getSession 永远优先模块级单例（见函数注释）
 */

import neo4j, { type Driver, type Session } from "neo4j-driver";
import type { EmbeddingConfig, Neo4jConfig } from "../types.ts";

let _driver: Driver | null = null;

/**
 * 获取 Neo4j Driver 单例
 */
export function getDriver(cfg: Neo4jConfig): Driver {
  if (_driver) return _driver;
  _driver = neo4j.driver(cfg.uri, neo4j.auth.basic(cfg.user, cfg.password), {
    maxConnectionPoolSize: 50,
    // 快速失败配合 gate.ts 熔断：掉线时 ~10s 内报错跳闸，而不是每次卡 30-60s
    connectionAcquisitionTimeout: 15_000,
    maxTransactionRetryTime: 10_000,
  });
  return _driver;
}

/**
 * 获取一个 Session（用完必须 close）
 *
 * 永远优先模块级 _driver 单例：调用方（register() 启动时捕获一次并四处传递）
 * 持有的旧引用在单例重建后会指向已关闭的池。入参仅作 getDriver 未初始化时
 * 的回退兼容。
 * 注：neo4j-driver 5.x 的 driver.session() 构造阶段不抛错，"Pool is closed"
 * 在 session.run() 才报——掉线恢复由 gate 熔断 + 驱动自身连接池重连负责，
 * 这里不做（也做不了）session 级重连。
 */
export function getSession(passedDriver: Driver): Session {
  return (_driver ?? passedDriver).session({ database: "neo4j" });
}

/**
 * 关闭 Driver（仅进程退出时调用）
 */
export async function closeDriver(): Promise<void> {
  if (_driver) {
    await _driver.close();
    _driver = null;
  }
}

/**
 * 初始化 Schema
 */
export async function initSchema(driver: Driver, embedding?: EmbeddingConfig): Promise<void> {
  const session = getSession(driver);
  try {
    // Per-label unique constraints
    for (const label of ["Task", "Skill", "Event"]) {
      await session.run(`CREATE CONSTRAINT ${label.toLowerCase()}_id IF NOT EXISTS FOR (n:${label}) REQUIRE n.id IS UNIQUE`);
      await session.run(`CREATE CONSTRAINT ${label.toLowerCase()}_name IF NOT EXISTS FOR (n:${label}) REQUIRE n.name IS UNIQUE`);
      await session.run(`CREATE INDEX ${label.toLowerCase()}_status IF NOT EXISTS FOR (n:${label}) ON (n.status)`);
      await session.run(`CREATE INDEX ${label.toLowerCase()}_community IF NOT EXISTS FOR (n:${label}) ON (n.communityId)`);
    }

    // Community
    await session.run("CREATE CONSTRAINT community_id IF NOT EXISTS FOR (c:Community) REQUIRE c.id IS UNIQUE");
    await session.run("CREATE INDEX community_member_signature IF NOT EXISTS FOR (c:Community) ON (c.memberSignature)");

    // Message (temporary extraction buffer)
    await session.run("CREATE CONSTRAINT gm_msg_id IF NOT EXISTS FOR (m:GmMessage) REQUIRE m.id IS UNIQUE");
    await session.run("CREATE INDEX gm_msg_session IF NOT EXISTS FOR (m:GmMessage) ON (m.sessionId, m.turnIndex)");

    const configuredDimensions = embedding?.dimensions;
    const dimensions = typeof configuredDimensions === "number" && Number.isInteger(configuredDimensions) && configuredDimensions > 0
      ? configuredDimensions
      : 1024;

    // The search code queries one index across all knowledge labels.
    // 补标守卫：仅给缺失 MemoryNode 标签的节点补标 —— 常规启动退化为纯读扫描，
    // 避免每次启动对全库做无谓写（属性/标签写会触发事务与日志）；首启/迁移兜底语义不变。
    await session.run("MATCH (n:Task|Skill|Event) WHERE NOT n:MemoryNode SET n:MemoryNode");

    // 存量 deprecated 节点补写 deprecatedAt（幂等，等效一次性迁移）：purge 时钟基准是
    // deprecatedAt、缺失时回退 updatedAt——但 upsertNode 对 manual/merge 弃用节点只 bump
    // updatedAt（不复活），存量无 deprecatedAt 的节点每次被重新提取命中都会把 purge 期限
    // 往后推（无限续命、永远删不掉）。启动时把时钟一次性钉死为当时的
    // coalesce(updatedAt, createdAt) 快照，此后 purge 不再受 updatedAt 漂移影响。
    // 全新弃用路径（manual/merge/decay）都已显式写 deprecatedAt，故首次运行后恒零命中。
    await session.run(`
      MATCH (n:Task|Skill|Event {status: 'deprecated'})
      WHERE n.deprecatedAt IS NULL
      SET n.deprecatedAt = coalesce(n.updatedAt, n.createdAt)
    `);

    await session.run(`
      CREATE VECTOR INDEX gm_node_embedding IF NOT EXISTS
      FOR (n:MemoryNode) ON (n.embedding)
      OPTIONS {indexConfig: {\`vector.dimensions\`: ${dimensions}, \`vector.similarity_function\`: 'cosine'}}
    `);
    await session.run(`
      CREATE VECTOR INDEX gm_community_embedding IF NOT EXISTS
      FOR (c:Community) ON (c.embedding)
      OPTIONS {indexConfig: {\`vector.dimensions\`: ${dimensions}, \`vector.similarity_function\`: 'cosine'}}
    `);

    // Turn commit marker (OpenClaw transcript fencing contract).
    // 放在 DDL 链末尾：升级后首启若约束尚未建好，并发重试的 CREATE 可能
    // 已写入重复 advancementKey —— 带冲突数据的 CREATE CONSTRAINT 会失败，
    // 先清重复行再建约束；即使这里失败也不能波及上面的向量索引。
    // 唯一约束是幂等提交的原子性来源：重试的 CREATE 撞约束报
    // ConstraintValidationFailed，commitTurnAdvance 据此区分 committed/duplicate。
    await session.run(`
      MATCH (t:GmTurnCommit)
      WITH t.advancementKey AS key, collect(t) AS marks
      WHERE size(marks) > 1
      FOREACH (n IN marks[1..] | DELETE n)
    `);
    await session.run("CREATE CONSTRAINT gm_turn_commit_key IF NOT EXISTS FOR (t:GmTurnCommit) REQUIRE t.advancementKey IS UNIQUE");
  } finally {
    await session.close();
  }
}
