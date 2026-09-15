import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Driver } from "neo4j-driver";
import { getDriver, initSchema, closeDriver, getSession } from "../src/store/db.ts";
import { commitTurnAdvance } from "../src/store/store.ts";

// 仅在显式提供 NEO4J_TEST_URI 时运行（需要 Docker Neo4j，CI 执行）。
// 刻意不默认 bolt://localhost:7687：本测试会写/删数据，绝不允许
// 因缺省值静默落到可能是真实数据库的端口上。
const NEO4J_URI = process.env.NEO4J_TEST_URI;
const ENABLED = !!process.env.NEO4J_INTEGRATION && !!NEO4J_URI;
const SID = `turncommit-${Date.now()}`;

let driver: Driver;

async function markerCount(advancementKey: string): Promise<number> {
  const session = getSession(driver);
  try {
    const res = await session.run(
      "MATCH (t:GmTurnCommit {advancementKey: $key}) RETURN count(t) AS c",
      { key: advancementKey },
    );
    return Number(res.records[0].get("c"));
  } finally {
    await session.close();
  }
}

describe.skipIf(!ENABLED)("GmTurnCommit marker (Docker)", () => {
  beforeAll(async () => {
    driver = getDriver({
      uri: NEO4J_URI!,
      user: process.env.NEO4J_TEST_USER ?? "neo4j",
      // Keep the local fallback aligned with the disposable Neo4j instance in CI.
      password: process.env.NEO4J_TEST_PASSWORD ?? "graphmemory",
    });
    await initSchema(driver);
  });

  afterAll(async () => {
    // 只清理本测试写入的标记，不动其他数据
    const session = getSession(driver);
    try {
      await session.run(
        "MATCH (t:GmTurnCommit {sessionId: $sid}) DETACH DELETE t",
        { sid: SID },
      );
    } finally {
      await session.close();
    }
    await closeDriver();
  });

  it("initSchema creates the uniqueness constraint backing atomic idempotent commits", async () => {
    const session = getSession(driver);
    try {
      const res = await session.run(
        "SHOW CONSTRAINTS YIELD type, labelsOrTypes " +
        "WHERE type = 'UNIQUENESS' AND 'GmTurnCommit' IN labelsOrTypes " +
        "RETURN type",
      );
      expect(res.records.length).toBeGreaterThanOrEqual(1);
    } finally {
      await session.close();
    }
  });

  it("first write commits, retry with the same advancementKey reports duplicate", async () => {
    const key = `${SID}-retry`;
    await expect(commitTurnAdvance(driver, SID, key, 3)).resolves.toBe("committed");
    await expect(commitTurnAdvance(driver, SID, key, 3)).resolves.toBe("duplicate");
    expect(await markerCount(key)).toBe(1);
  });

  it("distinct advancementKeys commit independently", async () => {
    await expect(commitTurnAdvance(driver, SID, `${SID}-a`, 1)).resolves.toBe("committed");
    await expect(commitTurnAdvance(driver, SID, `${SID}-b`, 2)).resolves.toBe("committed");
    expect(await markerCount(`${SID}-a`)).toBe(1);
    expect(await markerCount(`${SID}-b`)).toBe(1);
  });
});
