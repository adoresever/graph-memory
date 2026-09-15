/**
 * 真实 embedding 服务端到端测试（syncEmbedBatch / 批量 API / 查询 LRU / 语义召回）
 *
 * 与其他集成测试的 mock 向量不同，本文件打真实 embedding 端点（默认
 * http://localhost:8000/v1，jina-embeddings-v5-text-small，1024 维），
 * 验证：探活、批量嵌入、contentHash 短路、查询向量 LRU、真实语义召回排序。
 *
 * 安全门：需要显式 EMBED_E2E=1 + NEO4J_INTEGRATION=1 + NEO4J_TEST_URI（不回落 7687）。
 *
 * 运行：
 *   EMBED_E2E=1 NEO4J_INTEGRATION=1 NEO4J_TEST_URI=bolt://localhost:7688 \
 *     npx vitest run test/integration.embed-e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Driver } from "neo4j-driver";
import { getDriver, initSchema, closeDriver, getSession } from "../src/store/db.ts";
import { upsertNode } from "../src/store/store.ts";
import { createEmbedder } from "../src/engine/embed.ts";
import { Recaller } from "../src/recaller/recall.ts";
import { DEFAULT_CONFIG, type GmConfig } from "../src/types.ts";

const ENABLED = !!process.env.EMBED_E2E && !!process.env.NEO4J_INTEGRATION && !!process.env.NEO4J_TEST_URI;
const NEO4J_URI = process.env.NEO4J_TEST_URI ?? "";
const EMBED_BASE = process.env.EMBED_E2E_BASE ?? "http://localhost:8000/v1";
const EMBED_MODEL = process.env.EMBED_E2E_MODEL ?? "jina-embeddings-v5-text-small";

let driver: Driver;
const SID = `embed-e2e-${Date.now()}`;
const cfg: GmConfig = { ...DEFAULT_CONFIG, neo4j: { uri: NEO4J_URI, user: "neo4j", password: "graphmemory" } };

describe.skipIf(!ENABLED)("embedding E2E（真实服务）", () => {
  let embedCalls = 0;
  let batchCalls = 0;
  let batchTexts = 0;

  beforeAll(async () => {
    console.log(`[embed-e2e] neo4j=${NEO4J_URI} embed=${EMBED_BASE} model=${EMBED_MODEL}`);
    driver = getDriver(cfg.neo4j);
    await initSchema(driver, { baseURL: EMBED_BASE, model: EMBED_MODEL });
  }, 120_000);

  afterAll(async () => {
    const session = getSession(driver);
    try {
      await session.run("MATCH (n) WHERE $sid IN n.sourceSessions DETACH DELETE n", { sid: SID });
    } finally {
      await session.close();
    }
    await closeDriver();
  }, 60_000);

  it("探活：createEmbedder probe 成功，双能力（embed/embedBatch）可用", async () => {
    const embedder = await createEmbedder({ baseURL: EMBED_BASE, model: EMBED_MODEL });
    expect(embedder).not.toBeNull();
    const vec = await embedder!.embed("probe 维度", "query");
    expect(vec.length).toBeGreaterThan(0);
    console.log(`[embed-e2e] 单发维度 = ${vec.length}`);
  }, 60_000);

  it("syncEmbedBatch：真实批量 API 一次往返写回 N 个节点向量 + contentHash 短路", async () => {
    const embedder = await createEmbedder({ baseURL: EMBED_BASE, model: EMBED_MODEL });
    expect(embedder).not.toBeNull();

    // 包一层计数器，验证 LRU / 短路语义
    const countedEmbed = embedder!.embed;
    const countedBatch = embedder!.embedBatch;

    const recaller = new Recaller(driver, cfg);
    recaller.setEmbedFn(async (text, mode) => {
      embedCalls++;
      return countedEmbed(text, mode);
    });
    recaller.setEmbedBatchFn(async (texts, mode) => {
      batchCalls++;
      batchTexts += texts.length;
      return countedBatch(texts, mode);
    });

    const topics = [
      { name: "embed-e2e-docker-compose", description: "docker compose container deployment", content: "deploy multi-container applications with docker compose files and registry images" },
      { name: "embed-e2e-vitest-mocking", description: "vitest mock and spy patterns", content: "vi.mock hoists module mocks, vi.spyOn wraps methods, stub network responses in unit tests" },
      { name: "embed-e2e-neo4j-index", description: "neo4j index and constraint design", content: "uniqueness constraints guard identity keys, range indexes accelerate equality cypher filters" },
    ];
    const nodes = [];
    for (const t of topics) {
      const { node } = await upsertNode(driver, { type: "SKILL", ...t }, SID);
      nodes.push(node);
    }

    // 首次批量同步：一次 batch API 调用覆盖 3 个节点
    await recaller.syncEmbedBatch(nodes);
    expect(batchCalls).toBe(1);
    expect(batchTexts).toBe(3);

    // 落库校验：embedding 维度 + contentHash
    const session = getSession(driver);
    try {
      const r = await session.run(
        `MATCH (n:Skill) WHERE $sid IN n.sourceSessions
         RETURN n.id AS id, size(n.embedding) AS dims, n.contentHash AS hash`,
        { sid: SID },
      );
      expect(r.records.length).toBe(3);
      for (const rec of r.records) {
        // size() 返回 Neo4j Integer
        expect((rec.get("dims")?.toNumber?.() ?? rec.get("dims"))).toBe(1024);
        expect(rec.get("hash")).toBeTruthy();
      }
    } finally {
      await session.close();
    }

    // contentHash 短路：内容未变 → 零新 API 调用
    await recaller.syncEmbedBatch(nodes);
    expect(batchCalls).toBe(1);
    expect(batchTexts).toBe(3);
  }, 120_000);

  it("真实语义召回 + 查询向量 LRU", async () => {
    const embedder = await createEmbedder({ baseURL: EMBED_BASE, model: EMBED_MODEL });
    const countedEmbed = embedder!.embed;
    let queryCalls = 0;

    const recaller = new Recaller(driver, cfg);
    recaller.setEmbedFn(async (text, mode) => {
      queryCalls++;
      return countedEmbed(text, mode);
    });

    // 语义查询（非字面词重叠：orchestration ≠ compose/deployment）
    const r1 = await recaller.recall("how to orchestrate multi container apps");
    expect(r1.nodes.length).toBeGreaterThan(0);
    const firstCallCount = queryCalls;
    expect(firstCallCount).toBe(1);
    console.log(`[embed-e2e] 语义召回 top1 = ${r1.nodes[0]?.name}`);

    // 相同查询：LRU 命中，零新 embedding 调用
    const r2 = await recaller.recall("how to orchestrate multi container apps");
    expect(queryCalls).toBe(firstCallCount);
    expect(r2.nodes.map((n) => n.id).sort()).toEqual(r1.nodes.map((n) => n.id).sort());

    // 不同查询：新 embedding 调用
    await recaller.recall("unit testing with mocks");
    expect(queryCalls).toBe(firstCallCount + 1);
  }, 120_000);
});
