/**
 * graph-memory-pro — Neo4j 连接管理（加固版）
 *
 * 解决 "Pool is closed" 问题：
 * - driver 是长生命周期单例，不在 dispose 时关闭
 * - getSession 在 driver 被意外关闭时自动重建
 */

import neo4j, { type Driver, type Session } from "neo4j-driver";
import type { EmbeddingConfig, Neo4jConfig } from "../types.ts";

let _driver: Driver | null = null;
let _cfg: Neo4jConfig | null = null;

/**
 * 获取 Neo4j Driver 单例
 * 保存配置，支持自动重连
 */
export function getDriver(cfg: Neo4jConfig): Driver {
  _cfg = cfg;
  if (_driver) return _driver;
  _driver = neo4j.driver(cfg.uri, neo4j.auth.basic(cfg.user, cfg.password), {
    maxConnectionPoolSize: 50,
    connectionAcquisitionTimeout: 60000,
    maxTransactionRetryTime: 30000,
  });
  return _driver;
}

/**
 * 获取一个 Session（用完必须 close）
 * 如果 driver 被关闭了，自动用保存的配置重建
 */
export function getSession(driver: Driver): Session {
  try {
    return driver.session({ database: "neo4j" });
  } catch (err) {
    // Pool is closed — 尝试重建 driver
    if (_cfg && String(err).includes("closed")) {
      console.log("[graph-memory-pro] reconnecting Neo4j driver...");
      _driver = neo4j.driver(_cfg.uri, neo4j.auth.basic(_cfg.user, _cfg.password), {
        maxConnectionPoolSize: 50,
        connectionAcquisitionTimeout: 60000,
        maxTransactionRetryTime: 30000,
      });
      return _driver.session({ database: "neo4j" });
    }
    throw err;
  }
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

    // Message (temporary extraction buffer)
    await session.run("CREATE CONSTRAINT gm_msg_id IF NOT EXISTS FOR (m:GmMessage) REQUIRE m.id IS UNIQUE");
    await session.run("CREATE INDEX gm_msg_session IF NOT EXISTS FOR (m:GmMessage) ON (m.sessionId, m.turnIndex)");

    const configuredDimensions = embedding?.dimensions;
    const dimensions = typeof configuredDimensions === "number" && Number.isInteger(configuredDimensions) && configuredDimensions > 0
      ? configuredDimensions
      : 1024;

    // The search code queries one index across all knowledge labels.
    await session.run("MATCH (n:Task|Skill|Event) SET n:MemoryNode");
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
  } finally {
    await session.close();
  }
}
