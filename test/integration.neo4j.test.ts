import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Driver } from "neo4j-driver";
import { getDriver, initSchema, closeDriver, getSession } from "../src/store/db.ts";
import {
  upsertNode, findByName, findById, updateNode,
  upsertEdge, edgesFrom, graphWalk,
  saveMessage, getUnextracted, markExtracted, isTurnExtracted,
  deprecate, getStats,
} from "../src/store/store.ts";

// 仅在 NEO4J_INTEGRATION=1 时运行，避免污染默认 npm test（需要 Docker Neo4j）
const ENABLED = !!process.env.NEO4J_INTEGRATION;

let driver: Driver;
const TEST_SID = `integration-${Date.now()}`;

describe.skipIf(!ENABLED)("Neo4j integration (Docker)", () => {
  beforeAll(async () => {
    driver = getDriver({ uri: "bolt://localhost:7687", user: "neo4j", password: "graphmemory" });
    await initSchema(driver);
  }, 60000);

  afterAll(async () => {
    const session = getSession(driver);
    try {
      await session.run("MATCH (n) WHERE $sid IN n.sourceSessions DETACH DELETE n", { sid: TEST_SID });
      await session.run("MATCH (m:GmMessage {sessionId: $sid}) DELETE m", { sid: TEST_SID });
    } finally {
      await session.close();
    }
    await closeDriver();
  }, 30000);

  it("upsertNode 创建节点 + findByName 取回（名称标准化）", async () => {
    const { node, isNew } = await upsertNode(driver, {
      type: "SKILL", name: "Docker Build",
      description: "build images", content: "docker build -t name .",
    }, TEST_SID);
    expect(isNew).toBe(true);
    expect(node.name).toBe("docker-build");
    expect(node.type).toBe("SKILL");

    const found = await findByName(driver, "Docker Build");
    expect(found).not.toBeNull();
    expect(found!.id).toBe(node.id);
  });

  it("upsertNode 同名更新（isNew=false，validatedCount 递增）", async () => {
    const { node, isNew } = await upsertNode(driver, {
      type: "SKILL", name: "Docker Build",
      description: "better desc", content: "longer content here",
    }, TEST_SID);
    expect(isNew).toBe(false);
    expect(node.validatedCount).toBeGreaterThanOrEqual(2);
  });

  it("updateNode (#57 移植) 按 name 更新 description/content 并持久化", async () => {
    const updated = await updateNode(driver, "docker-build", {
      description: "refined desc",
      content: "refined content",
    });
    expect(updated).not.toBeNull();
    expect(updated!.description).toBe("refined desc");
    expect(updated!.content).toBe("refined content");
    const refetch = await findByName(driver, "docker-build");
    expect(refetch!.description).toBe("refined desc");
    expect(refetch!.content).toBe("refined content");
  });

  it("updateNode 未知 name 返回 null", async () => {
    expect(await updateNode(driver, "ghost-node-xyz", { description: "x" })).toBeNull();
  });

  it("upsertEdge (APOC) 建边 + edgesFrom 取回", async () => {
    const { node: task } = await upsertNode(driver, {
      type: "TASK", name: "Deploy App", description: "d", content: "c",
    }, TEST_SID);
    const { node: skill } = await upsertNode(driver, {
      type: "SKILL", name: "CI/CD Pipeline", description: "d", content: "c",
    }, TEST_SID);
    await upsertEdge(driver, {
      fromId: task.id, toId: skill.id, type: "USED_SKILL",
      instruction: "uses", sessionId: TEST_SID,
    });
    const edges = await edgesFrom(driver, task.id);
    expect(edges.length).toBeGreaterThanOrEqual(1);
    expect(edges.some(e => e.type === "USED_SKILL" && e.toId === skill.id)).toBe(true);
  });

  it("graphWalk 从 seed 遍历到关联节点", async () => {
    const seed = await findByName(driver, "deploy-app");
    expect(seed).not.toBeNull();
    const { nodes, edges } = await graphWalk(driver, [seed!.id], 2);
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    // CI/CD Pipeline 标准化为 cicd-pipeline
    expect(nodes.some(n => n.name === "cicd-pipeline")).toBe(true);
    expect(edges.some(e => e.type === "USED_SKILL")).toBe(true);
  });

  it("saveMessage + getUnextracted + markExtracted + isTurnExtracted (#1/#2 修复路径)", async () => {
    await saveMessage(driver, TEST_SID, 100, "user", { text: "hello" });
    await saveMessage(driver, TEST_SID, 101, "turn", [{ role: "user", content: "x" }]);

    const before = await getUnextracted(driver, TEST_SID, 10);
    expect(before.length).toBeGreaterThanOrEqual(2);
    expect(await isTurnExtracted(driver, TEST_SID, 100)).toBe(false);

    await markExtracted(driver, TEST_SID, 101); // marks all turnIndex <= 101

    expect(await isTurnExtracted(driver, TEST_SID, 100)).toBe(true);
    expect(await isTurnExtracted(driver, TEST_SID, 101)).toBe(true);

    const after = await getUnextracted(driver, TEST_SID, 10);
    expect(after.length).toBe(0);
  });

  it("getStats (#9 去除冗余查询后) 返回完整结构", async () => {
    const stats = await getStats(driver);
    expect(stats).toHaveProperty("totalNodes");
    expect(stats).toHaveProperty("byType");
    expect(stats).toHaveProperty("totalEdges");
    expect(stats).toHaveProperty("byEdgeType");
    expect(stats).toHaveProperty("communities");
    expect(typeof stats.totalNodes).toBe("number");
    expect(stats.totalNodes).toBeGreaterThanOrEqual(1);
    expect(stats.byType.SKILL).toBeGreaterThanOrEqual(1);
  });

  it("deprecate 软删除（status=deprecated，节点仍存在）", async () => {
    const { node } = await upsertNode(driver, {
      type: "EVENT", name: "Temp Event", description: "d", content: "c",
    }, TEST_SID);
    await deprecate(driver, node.id);
    const refetch = await findById(driver, node.id);
    expect(refetch).not.toBeNull();
    expect(refetch!.status).toBe("deprecated");
  });
});
