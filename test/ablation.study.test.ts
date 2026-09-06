/**
 * graph-memory-pro — 消融实验 (ablation study)
 *
 * 三组消融，量化各组件对系统质量的贡献：
 *   A. 召回管线：向量种子 / GDS PPR 排序 / 社区扩展 / 双路径（precise+generalized）
 *   B. 向量去重：dedup 对图规模收缩与召回多样性的贡献
 *   C. 遗忘曲线：decay + autoDeprecate 对陈旧知识的遗忘（含 tier 转换）
 *
 * 安全门（生产库保护，最高优先级）：
 *   - 仅当 ABLATION_STUDY=1 时启用；普通 npm test / CI 永远跳过本文件
 *   - NEO4J_TEST_URI 必须显式设置，否则整体跳过 —— 绝不回落 7687 默认值
 *
 * 运行（一次性 Docker Neo4j，bolt 映射到 7688）：
 *   ABLATION_STUDY=1 NEO4J_TEST_URI=bolt://localhost:7688 \
 *     npx vitest run test/ablation.study.test.ts
 *
 * 全程使用确定性 mock embedder（bag-of-words 符号哈希 → 1024 维 L2 归一化向量），
 * 不调用任何外部 LLM / embedding API。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Driver } from "neo4j-driver";
import { createHash } from "crypto";
import { writeFile, mkdir } from "fs/promises";
import { fileURLToPath } from "url";
import path from "node:path";
import { getDriver, initSchema, closeDriver, getSession } from "../src/store/db.ts";
import {
  upsertNode, upsertEdge, saveVector, saveCommunityEmbedding,
  searchNodes, vectorSearchWithScore, graphWalk,
  communityRepresentatives, communityVectorSearch, nodesByCommunityIds,
} from "../src/store/store.ts";
import {
  detectCommunities, getCommunityPeers, buildCommunityMemberSignature,
} from "../src/graph/community.ts";
import { personalizedPageRank, computeGlobalPageRank } from "../src/graph/pagerank.ts";
import { dedup, detectDuplicates } from "../src/graph/dedup.ts";
import { applyDecay } from "../src/graph/decay.ts";
import { Recaller, buildNodeEmbeddingText } from "../src/recaller/recall.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import type { GmConfig, GmNode, RecallResult, EdgeType, NodeType } from "../src/types.ts";
import type { EmbedFn } from "../src/engine/embed.ts";

// ─── 安全门 ─────────────────────────────────────────────────

const ENABLED = !!process.env.ABLATION_STUDY && !!process.env.NEO4J_TEST_URI;
const NEO4J_URI = process.env.NEO4J_TEST_URI ?? "";

const CFG: GmConfig = {
  ...DEFAULT_CONFIG,
  neo4j: { uri: NEO4J_URI, user: "neo4j", password: "graphmemory" },
  recallMaxNodes: 6,
  recallMaxDepth: 2,
};
const K = CFG.recallMaxNodes;

// ─── 确定性 embedder（bag-of-words 符号哈希）─────────────────

const DIM = 1024;

function embedText(text: string): number[] {
  const vec = new Array<number>(DIM).fill(0);
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  for (const w of words) {
    const digest = createHash("md5").update(w).digest();
    const code = digest.readUInt32BE(0);
    const idx = code % DIM;
    const sign = (digest[4] & 1) === 0 ? 1 : -1;
    vec[idx] += sign;
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => v / norm);
}

const mockEmbedFn: EmbedFn = async (text) => embedText(text);

function meanVector(texts: string[]): number[] {
  const acc = new Array<number>(DIM).fill(0);
  for (const t of texts) {
    const v = embedText(t);
    for (let i = 0; i < DIM; i++) acc[i] += v[i];
  }
  let norm = 0;
  for (const v of acc) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return acc.map((v) => v / norm);
}

// ─── 指标 ───────────────────────────────────────────────────

interface Metrics {
  recallAtK: number;
  precisionAtK: number;
  mrr: number;
  nodesReturned: number;
}

function scoreResult(result: RecallResult, relevant: Set<string>): Metrics {
  const retrieved = result.nodes.slice(0, K).map((n) => n.id);
  const hits = retrieved.filter((id) => relevant.has(id));
  const firstHit = retrieved.findIndex((id) => relevant.has(id));
  return {
    recallAtK: relevant.size ? hits.length / relevant.size : 0,
    precisionAtK: retrieved.length ? hits.length / retrieved.length : 0,
    mrr: firstHit >= 0 ? 1 / (firstHit + 1) : 0,
    nodesReturned: result.nodes.length,
  };
}

interface Row {
  suite: string;
  config: string;
  recallAtK: string;
  precisionAtK: string;
  mrr: string;
  nodes: string;
  latencyMs: string;
  note: string;
}

const ROWS: Row[] = [];

function addRow(suite: string, config: string, m: Metrics, latencyMs: number, note = ""): void {
  ROWS.push({
    suite,
    config,
    recallAtK: m.recallAtK.toFixed(3),
    precisionAtK: m.precisionAtK.toFixed(3),
    mrr: m.mrr.toFixed(3),
    nodes: `${m.nodesReturned}`,
    latencyMs: latencyMs.toFixed(0),
    note,
  });
}

function averageMetrics(list: Metrics[]): Metrics {
  const n = list.length || 1;
  return {
    recallAtK: list.reduce((s, m) => s + m.recallAtK, 0) / n,
    precisionAtK: list.reduce((s, m) => s + m.precisionAtK, 0) / n,
    mrr: list.reduce((s, m) => s + m.mrr, 0) / n,
    nodesReturned: list.reduce((s, m) => s + m.nodesReturned, 0) / n,
  };
}

// ─── 召回管线 harness（逐行镜像 src/recaller/recall.ts，组件可开关）───

interface Flags {
  vector: boolean;
  communityExpansion: boolean;
  ppr: boolean;
  precise: boolean;
  generalized: boolean;
}

const FULL: Flags = {
  vector: true, communityExpansion: true, ppr: true, precise: true, generalized: true,
};

let driver: Driver;

async function pipelinePrecise(
  query: string, limit: number, embedPromise: Promise<number[] | null>, flags: Flags,
): Promise<RecallResult> {
  let seeds: GmNode[] = [];

  const vec = await embedPromise;
  if (vec) {
    try {
      const scored = await vectorSearchWithScore(driver, vec, Math.ceil(limit / 2));
      seeds = scored.map((s) => s.node);
      if (seeds.length < 2) {
        const fts = await searchNodes(driver, query, limit);
        const seen = new Set(seeds.map((n) => n.id));
        seeds.push(...fts.filter((n) => !seen.has(n.id)));
      }
    } catch {
      seeds = await searchNodes(driver, query, limit);
    }
  } else {
    seeds = await searchNodes(driver, query, limit);
  }

  if (!seeds.length) return { nodes: [], edges: [] };
  const seedIds = seeds.map((n) => n.id);

  const expandedIds = new Set(seedIds);
  if (flags.communityExpansion) {
    for (const seed of seeds) {
      const peers = await getCommunityPeers(driver, seed.id, 2);
      for (const peerId of peers) expandedIds.add(peerId);
    }
  }

  const { nodes, edges } = await graphWalk(driver, Array.from(expandedIds), CFG.recallMaxDepth);
  if (!nodes.length) return { nodes: [], edges: [] };

  const candidateIds = nodes.map((n) => n.id);
  const { scores } = flags.ppr
    ? await personalizedPageRank(driver, seedIds, candidateIds, CFG)
    : { scores: new Map<string, number>() };

  const filtered = nodes
    .sort((a, b) =>
      (scores.get(b.id) || 0) - (scores.get(a.id) || 0) ||
      b.validatedCount - a.validatedCount ||
      b.updatedAt - a.updatedAt)
    .slice(0, limit);

  const ids = new Set(filtered.map((n) => n.id));
  return { nodes: filtered, edges: edges.filter((e) => ids.has(e.fromId) && ids.has(e.toId)) };
}

async function pipelineGeneralized(
  limit: number, embedPromise: Promise<number[] | null>,
): Promise<RecallResult> {
  let seeds: GmNode[] = [];

  const vec = await embedPromise;
  if (vec) {
    try {
      const scoredCommunities = await communityVectorSearch(driver, vec);
      if (scoredCommunities.length > 0) {
        seeds = await nodesByCommunityIds(driver, scoredCommunities.map((c) => c.id), 3);
      }
    } catch { /* 与 recall.ts 一致：静默落 representatives 兜底 */ }
  }

  if (!seeds.length) seeds = await communityRepresentatives(driver, 2);
  if (!seeds.length) return { nodes: [], edges: [] };

  const seedIds = seeds.map((n) => n.id);
  const { nodes, edges } = await graphWalk(driver, seedIds, 1);
  if (!nodes.length) return { nodes: [], edges: [] };

  const candidateIds = nodes.map((n) => n.id);
  const { scores } = await personalizedPageRank(driver, seedIds, candidateIds, CFG);

  const filtered = nodes
    .sort((a, b) =>
      (scores.get(b.id) || 0) - (scores.get(a.id) || 0) ||
      b.updatedAt - a.updatedAt ||
      b.validatedCount - a.validatedCount)
    .slice(0, limit);

  const ids = new Set(filtered.map((n) => n.id));
  return { nodes: filtered, edges: edges.filter((e) => ids.has(e.fromId) && ids.has(e.toId)) };
}

function mergeResults(a: RecallResult, b: RecallResult): RecallResult {
  const nodeMap = new Map<string, GmNode>();
  const edgeMap = new Map<string, (typeof a.edges)[number]>();
  for (const n of a.nodes) nodeMap.set(n.id, n);
  for (const e of a.edges) edgeMap.set(e.id, e);
  for (const n of b.nodes) if (!nodeMap.has(n.id)) nodeMap.set(n.id, n);
  const finalIds = new Set(nodeMap.keys());
  for (const e of b.edges) {
    if (!edgeMap.has(e.id) && finalIds.has(e.fromId) && finalIds.has(e.toId)) edgeMap.set(e.id, e);
  }
  return { nodes: Array.from(nodeMap.values()), edges: Array.from(edgeMap.values()) };
}

async function recallPipeline(query: string, flags: Flags): Promise<RecallResult> {
  const limit = CFG.recallMaxNodes;
  const embedPromise: Promise<number[] | null> = flags.vector
    ? mockEmbedFn(query).catch(() => null)
    : Promise.resolve(null);

  const paths: Array<Promise<RecallResult>> = [];
  if (flags.precise) paths.push(pipelinePrecise(query, limit, embedPromise, flags));
  if (flags.generalized) paths.push(pipelineGeneralized(limit, embedPromise));

  const results = await Promise.all(paths);
  let merged: RecallResult = { nodes: [], edges: [] };
  for (const r of results) merged = mergeResults(merged, r);
  return merged;
}

// ─── 图 fixture ─────────────────────────────────────────────

const RUN = Date.now().toString(36);
const SID_RECALL = `abl-${RUN}`;
const SID_DUP_A = `abl-dupA-${RUN}`; // 去重启用臂
const SID_DUP_B = `abl-dupB-${RUN}`; // 去重消融臂
const SID_DECAY = `abl-dec-${RUN}`;
const CLEAN_PREFIX = "abl-";

interface FixtureNode {
  key: string;
  type: NodeType;
  name: string;
  description: string;
  content: string;
  topic: string;
  validatedCount?: number;
}

interface FixtureEdge { from: string; to: string; type: EdgeType; instruction: string }

const CLUSTERS: Array<{ topic: string; query: string; nodes: FixtureNode[] }> = [
  {
    topic: "docker-deployment",
    query: "deploy docker compose container stack registry",
    nodes: [
      { key: "dep-task", type: "TASK", name: "abl-docker-stack-deployment", description: "docker compose container deployment orchestration", content: "deploy the multi-container stack with docker compose, pulling service images from the registry, orchestrating rollout and scaling for production workloads", topic: "docker-deployment", validatedCount: 3 },
      { key: "dep-compose", type: "SKILL", name: "abl-compose-service-orchestration", description: "docker compose service orchestration patterns", content: "compose files declare docker services, networks and volumes; compose up orchestrates container startup order, health gates and rolling image replacement for the deployment stack", topic: "docker-deployment", validatedCount: 7 },
      { key: "dep-registry", type: "SKILL", name: "abl-container-registry-lifecycle", description: "container image registry lifecycle", content: "version and push container images to the registry, scan layers, sign tags, promote build artifacts through staging channels before docker deployment", topic: "docker-deployment", validatedCount: 5 },
      { key: "dep-outage", type: "EVENT", name: "abl-registry-outage-postmortem", description: "registry outage during deployment", content: "the docker deployment stalled when the registry rate limited image pulls; container startup backoff cascaded until the compose stack pinned digest references", topic: "docker-deployment", validatedCount: 1 },
    ],
  },
  {
    topic: "vitest-testing",
    query: "vitest unit test mock spy coverage",
    nodes: [
      { key: "test-task", type: "TASK", name: "abl-unit-test-suite-setup", description: "vitest unit test suite setup", content: "scaffold a vitest workspace, configure unit test discovery, assertion styles and coverage collection for the repository test suite", topic: "vitest-testing", validatedCount: 2 },
      { key: "test-mocking", type: "SKILL", name: "abl-vitest-mocking-patterns", description: "vitest mocking and spy patterns", content: "vi.mock hoists module mocks, vi.spyOn wraps methods, mockReturnValue stubs responses, mock timers control asynchronous test flow in vitest", topic: "vitest-testing", validatedCount: 8 },
      { key: "test-coverage", type: "SKILL", name: "abl-coverage-threshold-gates", description: "coverage threshold gates", content: "v8 coverage provider maps uncovered branches, istanbul thresholds fail the test pipeline below eighty percent, coverage exclude lists keep fixtures out of the report", topic: "vitest-testing", validatedCount: 4 },
      { key: "test-flaky", type: "EVENT", name: "abl-flaky-spec-retrospective", description: "flaky spec retrospective", content: "a unit spec flickered until the spy leaked between tests; resetting mocks in beforeEach and stubbing timers made the vitest suite deterministic", topic: "vitest-testing", validatedCount: 1 },
    ],
  },
  {
    topic: "neo4j-schema",
    query: "neo4j cypher index constraint migration",
    nodes: [
      { key: "neo-task", type: "TASK", name: "abl-graph-schema-migration", description: "graph schema migration planning", content: "plan the schema migration in ordered cypher batches: create indexes and constraints first, backfill properties, then verify node counts before cutover", topic: "neo4j-schema", validatedCount: 3 },
      { key: "neo-cypher", type: "SKILL", name: "abl-cypher-query-optimization", description: "cypher query optimization", content: "profile query plans, replace cartesian products with anchored matches, hint range index scans, and batch apoc.periodic.iterate updates to keep the database responsive", topic: "neo4j-schema", validatedCount: 6 },
      { key: "neo-schema", type: "SKILL", name: "abl-neo4j-constraint-design", description: "neo4j constraint and index design", content: "uniqueness constraints guard identity keys, range indexes accelerate equality filters, fulltext indexes back keyword search, and constraint violations abort the migration transaction", topic: "neo4j-schema", validatedCount: 5 },
      { key: "neo-incident", type: "EVENT", name: "abl-slow-query-incident", description: "slow query incident review", content: "dashboard latency spiked when a migration dropped a covering index mid-deploy; cypher queries degraded to filters until the constraint and index pair was restored", topic: "neo4j-schema", validatedCount: 1 },
    ],
  },
  {
    topic: "typescript-build",
    query: "typescript tsconfig module compilation strict",
    nodes: [
      { key: "ts-task", type: "TASK", name: "abl-tsconfig-modernization", description: "tsconfig modernization initiative", content: "audit every tsconfig in the monorepo, unify module resolution, tighten strict flags, and gate compilation in ci so declaration emit stays consistent", topic: "typescript-build", validatedCount: 2 },
      { key: "ts-strict", type: "SKILL", name: "abl-strict-mode-migration", description: "strict mode migration playbook", content: "noImplicitAny and strictNullChecks surface latent defects; codemods annotate signatures, null guards narrow control flow, and exhaustive switch checks harden the compilation boundary", topic: "typescript-build", validatedCount: 6 },
      { key: "ts-resolution", type: "SKILL", name: "abl-module-resolution-deep-dive", description: "module resolution deep dive", content: "bundler resolution rewrites relative extensions, paths aliases map workspace packages, verbatimModuleSyntax separates types, and the emit target guides output module shape", topic: "typescript-build", validatedCount: 4 },
      { key: "ts-buildbreak", type: "EVENT", name: "abl-ci-build-break-postmortem", description: "ci compilation break postmortem", content: "the pipeline failed when a tsconfig override disabled declaration emit; incremental cache masked it locally until ci compiled from clean and exposed the missing types", topic: "typescript-build", validatedCount: 1 },
    ],
  },
];

const DISTRACTORS: FixtureNode[] = [
  { key: "d-pasta", type: "SKILL", name: "abl-pasta-carbonara-notes", description: "italian pasta cooking notes", content: "guanciale rendered crisp, pecorino and egg emulsion, tonnarelli tossed off heat, black pepper finish, a roman classic rehearsed by feel not measure", topic: "misc" },
  { key: "d-japan", type: "SKILL", name: "abl-kyoto-itinerary-draft", description: "japan travel itinerary draft", content: "shinkansen from tokyo to kyoto, early fushimi inari gates, gion at dusk, day trip to nara deer park, temple bookings before cherry blossom peak", topic: "misc" },
  { key: "d-guitar", type: "SKILL", name: "abl-acoustic-chord-drills", description: "acoustic guitar chord drills", content: "fingerpick travis pattern over c g am f shapes, metronome at seventy, barre chord squeeze routine, pentatonic ladder across six strings daily", topic: "misc" },
  { key: "d-gym", type: "SKILL", name: "abl-strength-block-plan", description: "gym strength block plan", content: "five by five back squat progression, paused bench press, romanian deadlift volume, sled finisher, deload every fourth week", topic: "misc" },
  { key: "d-novel", type: "SKILL", name: "abl-novel-outline-v3", description: "novel chapter outline v3", content: "lighthouse keeper hides the ledger, storm chapter mirrors act one betrayal, viewpoint alternates diary and present, climax reframes the inheritance", topic: "misc" },
  { key: "d-tomato", type: "SKILL", name: "abl-tomato-bed-log", description: "tomato garden bed log", content: "amended clay with compost, drip line on timer, pruned suckers weekly, staked indeterminates, mulched before the heatwave", topic: "misc" },
  { key: "d-car", type: "SKILL", name: "abl-hatchback-service-log", description: "hatchback maintenance log", content: "synthetic oil every ten thousand kilometres, tire rotation cross pattern, brake pad thickness measured, cabin filter swapped in spring", topic: "misc" },
  { key: "d-coffee", type: "SKILL", name: "abl-pourover-recipe-card", description: "pour over coffee recipe card", content: "twenty gram dose, three hundred forty milliliters water at ninety three celsius, forty five second bloom, single pour spiral, medium grind settles flat", topic: "misc" },
  { key: "d-photo", type: "SKILL", name: "abl-exposure-triangle-notes", description: "photography exposure notes", content: "aperture controls depth of field, shutter freezes or drags motion, iso lifts shadows with noise cost, meter for highlights and push later", topic: "misc" },
  { key: "d-chess", type: "SKILL", name: "abl-sicilian-defence-prep", description: "chess sicilian defence prep", content: "najdorf move orders, english attack with be3 f3 g4, rook lift to g5, poisoned pawn line memorized to move twenty", topic: "misc" },
  { key: "d-spanish", type: "SKILL", name: "abl-spanish-streak-deck", description: "spanish vocabulary deck", content: "subjunctive triggers on influence verbs, por versus para contrast cards, spaced repetition streak at two hundred days, kitchen nouns themed batch", topic: "misc" },
  { key: "d-budget", type: "SKILL", name: "abl-household-budget-sheet", description: "household budget spreadsheet", content: "fixed costs bucketed, sinking funds for insurance premiums, grocery category averaged quarterly, savings rate plotted against overtime", topic: "misc" },
];

const RECALL_EDGES: FixtureEdge[] = [
  { from: "dep-task", to: "dep-compose", type: "USED_SKILL", instruction: "deploys with" },
  { from: "dep-task", to: "dep-registry", type: "USED_SKILL", instruction: "deploys with" },
  { from: "dep-compose", to: "dep-registry", type: "REQUIRES", instruction: "pulls images through" },
  { from: "dep-outage", to: "dep-registry", type: "SOLVED_BY", instruction: "mitigated by" },
  { from: "test-task", to: "test-mocking", type: "USED_SKILL", instruction: "tests with" },
  { from: "test-task", to: "test-coverage", type: "USED_SKILL", instruction: "tests with" },
  { from: "test-mocking", to: "test-coverage", type: "REQUIRES", instruction: "gated by" },
  { from: "test-flaky", to: "test-mocking", type: "SOLVED_BY", instruction: "mitigated by" },
  { from: "neo-task", to: "neo-cypher", type: "USED_SKILL", instruction: "migrates with" },
  { from: "neo-task", to: "neo-schema", type: "USED_SKILL", instruction: "migrates with" },
  { from: "neo-cypher", to: "neo-schema", type: "REQUIRES", instruction: "gated by" },
  { from: "neo-incident", to: "neo-cypher", type: "SOLVED_BY", instruction: "mitigated by" },
  { from: "ts-task", to: "ts-strict", type: "USED_SKILL", instruction: "migrates with" },
  { from: "ts-task", to: "ts-resolution", type: "USED_SKILL", instruction: "migrates with" },
  { from: "ts-strict", to: "ts-resolution", type: "REQUIRES", instruction: "gated by" },
  { from: "ts-buildbreak", to: "ts-strict", type: "SOLVED_BY", instruction: "mitigated by" },
  // 跨簇弱连接 ×2：检验社区检测/扩展在非完美分簇下的行为
  { from: "test-flaky", to: "ts-resolution", type: "SOLVED_BY", instruction: "mitigated by" },
  { from: "neo-cypher", to: "ts-resolution", type: "REQUIRES", instruction: "gated by" },
];

/** key → 落库后的真实 GmNode */
const nodeRegistry = new Map<string, GmNode>();

async function seedNodes(list: FixtureNode[], sid: string): Promise<void> {
  for (const f of list) {
    const { node } = await upsertNode(driver, {
      type: f.type, name: f.name, description: f.description, content: f.content,
    }, sid);
    nodeRegistry.set(f.key, node);
    await saveVector(driver, node.id, buildNodeEmbeddingText(node), embedText(buildNodeEmbeddingText(node)));
    if (f.validatedCount !== undefined) {
      const session = getSession(driver);
      try {
        await session.run(
          "MATCH (n:Task|Skill|Event {id: $id}) SET n.validatedCount = $vc",
          { id: node.id, vc: f.validatedCount },
        );
      } finally { await session.close(); }
    }
  }
}

async function seedEdges(list: FixtureEdge[], sid: string): Promise<void> {
  for (const e of list) {
    const from = nodeRegistry.get(e.from);
    const to = nodeRegistry.get(e.to);
    if (!from || !to) throw new Error(`fixture edge references unknown key: ${e.from} -> ${e.to}`);
    await upsertEdge(driver, {
      fromId: from.id, toId: to.id, type: e.type, instruction: e.instruction, sessionId: sid,
    });
  }
}

/** 为 detectCommunities 的每个社区按生产形态补建 Community 节点（id/summary/nodeCount/embedding） */
async function createCommunityNodes(): Promise<number> {
  const result = await detectCommunities(driver);
  expect(result.count).toBeGreaterThanOrEqual(3);
  for (const [cid, memberIds] of result.communities) {
    const members = memberIds
      .map((id) => Array.from(nodeRegistry.values()).find((n) => n.id === id))
      .filter((n): n is GmNode => !!n);
    const topicCounts = new Map<string, number>();
    for (const id of memberIds) {
      const entry = Array.from(CLUSTERS.flatMap((c) => c.nodes)).find((f) => nodeRegistry.get(f.key)?.id === id);
      if (entry) topicCounts.set(entry.topic, (topicCounts.get(entry.topic) ?? 0) + 1);
    }
    const topic = Array.from(topicCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "misc";
    const session = getSession(driver);
    try {
      await session.run(
        `MERGE (c:Community {id: $cid})
         SET c.summary = $summary, c.nodeCount = $count, c.memberSignature = $sig`,
        { cid, summary: `${topic} knowledge cluster`, count: memberIds.length, sig: buildCommunityMemberSignature(memberIds) },
      );
    } finally { await session.close(); }
    await saveCommunityEmbedding(driver, cid, meanVector(members.map((n) => buildNodeEmbeddingText(n))));
  }
  return result.count;
}

// ─── 套件 ───────────────────────────────────────────────────

describe.skipIf(!ENABLED)("graph-memory-pro ablation study", () => {

  beforeAll(async () => {
    console.log(`[ablation] NEO4J_TEST_URI = ${NEO4J_URI}（一次性容器，非生产库）`);
    driver = getDriver(CFG.neo4j);
    await initSchema(driver);

    // 环境自检：APOC + GDS 必须可用（否则 PPR/社区消融无意义）
    const session = getSession(driver);
    try {
      const r = await session.run("RETURN apoc.version() AS apoc, gds.version() AS gds");
      const rec = r.records[0];
      console.log(`[ablation] APOC ${rec.get("apoc")} / GDS ${rec.get("gds")}`);
      expect(rec.get("apoc")).toBeTruthy();
      expect(rec.get("gds")).toBeTruthy();
    } finally { await session.close(); }

    // 召回 cohort：4 主题簇 × 4 节点 + 12 干扰节点 + 簇内边 + 2 跨簇边
    await seedNodes([...CLUSTERS.flatMap((c) => c.nodes), ...DISTRACTORS], SID_RECALL);
    await seedEdges(RECALL_EDGES, SID_RECALL);
    // 全局 PageRank（searchNodes 排序依赖 n.pagerank）
    await computeGlobalPageRank(driver, CFG);
    // 社区检测 + Community 节点 + 社区向量（generalized 路径依赖）
    const communities = await createCommunityNodes();
    console.log(`[ablation] 召回 cohort 就绪：${CLUSTERS.length * 4 + DISTRACTORS.length} 节点，${communities} 社区`);
  }, 300_000);

  afterAll(async () => {
    const session = getSession(driver);
    try {
      await session.run(
        "MATCH (n) WHERE any(s IN n.sourceSessions WHERE s STARTS WITH $p) DETACH DELETE n",
        { p: CLEAN_PREFIX },
      );
      await session.run("MATCH (c:Community) DETACH DELETE c");
    } finally { await session.close(); }
    await closeDriver();
  }, 60_000);

  // ─── A. 召回管线消融 ─────────────────────────────────────

  describe("A. recall pipeline", () => {
    // 惰性构造：describe 块体在收集阶段执行（skip 不阻止），此时 beforeAll 尚未跑
    const queries = () => CLUSTERS.map((c) => ({
      query: c.query,
      relevant: new Set(c.nodes.map((n) => nodeRegistry.get(n.key)!.id)),
    }));

    const ABLATIONS: Array<{ label: string; flags: Flags }> = [
      { label: "full（全部开启）", flags: FULL },
      { label: "-vector（去向量，FTS 兜底）", flags: { ...FULL, vector: false } },
      { label: "-ppr（去 PPR 排序）", flags: { ...FULL, ppr: false } },
      { label: "-communityExpansion（去社区扩展）", flags: { ...FULL, communityExpansion: false } },
      { label: "-generalized（仅精确路径）", flags: { ...FULL, generalized: false } },
      { label: "-precise（仅泛化路径）", flags: { ...FULL, precise: false } },
    ];

    it("fidelity：harness full 管线与真实 Recaller.recall 输出一致", async () => {
      const recaller = new Recaller(driver, CFG);
      recaller.setEmbedFn(mockEmbedFn);
      for (const { query, relevant } of queries()) {
        const real = await recaller.recall(query);
        const harness = await recallPipeline(query, FULL);
        const realIds = new Set(real.nodes.map((n) => n.id));
        const harnessIds = new Set(harness.nodes.map((n) => n.id));
        let overlap = 0;
        for (const id of harnessIds) if (realIds.has(id)) overlap++;
        const ratio = harnessIds.size ? overlap / harnessIds.size : 1;
        console.log(`[ablation:fidelity] q="${query}" real=${realIds.size} harness=${harnessIds.size} overlap=${ratio.toFixed(2)}`);
        // 允许排序型微差，但集合重合度必须极高（harness 忠实性的门槛）
        expect(ratio).toBeGreaterThanOrEqual(0.8);
        expect(real.nodes.length).toBeGreaterThan(0);
        expect(scoreResult(real, relevant).recallAtK).toBeGreaterThan(0);
      }
    }, 300_000);

    it("消融矩阵：逐组件关闭并测量 recall/precision/MRR/延迟", async () => {
      for (const { label, flags } of ABLATIONS) {
        const perQuery: Metrics[] = [];
        let totalMs = 0;
        for (const { query, relevant } of queries()) {
          const t0 = performance.now();
          const result = await recallPipeline(query, flags);
          totalMs += performance.now() - t0;
          perQuery.push(scoreResult(result, relevant));
        }
        addRow("A.recall", label, averageMetrics(perQuery), totalMs / queries().length);
      }
    }, 300_000);

    it("sanity：full 配置召回质量高于零假设", async () => {
      // 单独重跑 full，给出可断言的聚合值（也验证矩阵运行后图未被污染）
      const { query, relevant } = queries()[0];
      const result = await recallPipeline(query, FULL);
      const m = scoreResult(result, relevant);
      expect(m.recallAtK).toBeGreaterThanOrEqual(0.5);
      addRow("A.recall", "full 复跑（sanity）", m, 0, "q=" + query);
    }, 120_000);
  });

  // ─── B. 去重消融 ─────────────────────────────────────────

  describe("B. dedup", () => {
    const DUP_CORE = "redis evicts least recently used keys first, ttl expiration sweeps lazy pass, maxmemory policy allkeys lru tunes cache hit rate under pressure";
    const NGINX_CORE = "nginx terminates tls at the edge, proxies upstream pools with least connections, buffers slow clients, and rewrites host headers for the internal mesh";
    const GRPC_CORE = "grpc clients balance across resolved endpoints, round robin picks per call, sticky streams pin to one backend, health checks drain unhealthy targets";

    const dupNodes: FixtureNode[] = [
      { key: "redis-base", type: "SKILL", name: "abl-redis-cache-eviction", description: "redis cache eviction policy", content: DUP_CORE, topic: "dup", validatedCount: 5 },
      { key: "redis-v1", type: "SKILL", name: "abl-redis-eviction-policy-v2", description: "redis cache eviction policy notes", content: `${DUP_CORE} benchmarked eviction latency`, topic: "dup", validatedCount: 1 },
      { key: "redis-v2", type: "SKILL", name: "abl-redis-eviction-runbook", description: "redis cache eviction runbook", content: `${DUP_CORE} documented runbook fallback`, topic: "dup", validatedCount: 1 },
      { key: "nginx-base", type: "SKILL", name: "abl-nginx-reverse-proxy", description: "nginx reverse proxy configuration", content: NGINX_CORE, topic: "dup", validatedCount: 5 },
      { key: "nginx-v1", type: "SKILL", name: "abl-nginx-proxy-config-v2", description: "nginx reverse proxy notes", content: `${NGINX_CORE} benchmarked proxy latency`, topic: "dup", validatedCount: 1 },
      { key: "nginx-v2", type: "SKILL", name: "abl-nginx-proxy-tuning", description: "nginx reverse proxy tuning", content: `${NGINX_CORE} documented tuning baseline`, topic: "dup", validatedCount: 1 },
      { key: "grpc-base", type: "SKILL", name: "abl-grpc-load-balancing", description: "grpc client load balancing", content: GRPC_CORE, topic: "dup", validatedCount: 5 },
      { key: "grpc-v1", type: "SKILL", name: "abl-grpc-balancing-notes", description: "grpc client balancing notes", content: `${GRPC_CORE} benchmarked picker behavior`, topic: "dup", validatedCount: 1 },
      { key: "kafka-base", type: "SKILL", name: "abl-kafka-consumer-retry", description: "kafka consumer retry semantics", content: "kafka consumers retry poison pills on a dedicated topic, exponential backoff before dead letter, offsets committed after the handler succeeds", topic: "dup", validatedCount: 5 },
    ];

    // 臂 B 副本：同内容不同名（name 唯一约束下这是产生"重复知识"的唯一方式，
    // 等价于跨 session 重复提取到同一知识的场景）
    const dupNodesB = dupNodes.map((f) => ({
      ...f, key: `${f.key}-b`, name: `${f.name}-b`, description: f.description,
    }));

    const DUP_TOPICS = ["redis", "nginx", "grpc", "kafka"];
    const DIVERSITY_QUERY = "redis cache eviction nginx proxy grpc balancing kafka retry";
    const PRECISE_ONLY: Flags = { ...FULL, generalized: false };

    /** 主题覆盖度量：top-K 覆盖的不同主题数 / 4 —— 近重复副本只计一次主题 */
    function topicMetrics(result: RecallResult): Metrics {
      const retrieved = result.nodes.slice(0, K);
      const covered: string[] = [];
      for (const n of retrieved) {
        const t = DUP_TOPICS.find((topic) => n.name.toLowerCase().includes(topic));
        if (t && !covered.includes(t)) covered.push(t);
      }
      const firstTopicIdx = retrieved.findIndex((n) =>
        DUP_TOPICS.some((topic) => n.name.toLowerCase().includes(topic)));
      return {
        recallAtK: covered.length / DUP_TOPICS.length,
        precisionAtK: retrieved.length ? covered.length / retrieved.length : 0,
        mrr: firstTopicIdx >= 0 ? 1 / (firstTopicIdx + 1) : 0,
        nodesReturned: result.nodes.length,
      };
    }

    beforeAll(async () => {
      // 只播种臂 A：臂 B 必须在臂 A 去重之后再播种（detectDuplicates 是全局扫描）
      await seedNodes(dupNodes, SID_DUP_A);
    }, 120_000);

    it("相似度门槛可检出近重复对（fixture 有效性）", async () => {
      const pairs = await detectDuplicates(driver, { ...CFG, dedupThreshold: 0.90 });
      const dupPairs = pairs.filter((p) =>
        p.nameA.startsWith("abl-redis") || p.nameA.startsWith("abl-nginx") || p.nameA.startsWith("abl-grpc"));
      console.log(`[ablation:dedup] 检出近重复对 ${dupPairs.length}（全局 ${pairs.length}）：` +
        dupPairs.slice(0, 8).map((p) => `${p.nameA}~${p.nameB}@${p.similarity.toFixed(3)}`).join(", "));
      expect(dupPairs.length).toBeGreaterThanOrEqual(6); // redis3 + nginx3 + grpc1 对
      for (const p of dupPairs) expect(p.similarity).toBeGreaterThanOrEqual(0.90);
    }, 120_000);

    it("臂 A：dedup 合并近重复 → 召回主题多样性", async () => {
      const armA = await dedup(driver, { ...CFG, dedupThreshold: 0.90 });
      console.log(`[ablation:dedup] 臂A 合并 ${armA.merged} 个节点（检出对 ${armA.pairs.length}）`);
      expect(armA.merged).toBeGreaterThanOrEqual(5);

      const t0 = performance.now();
      const resA = await recallPipeline(DIVERSITY_QUERY, PRECISE_ONLY);
      const msA = performance.now() - t0;
      const mA = topicMetrics(resA);
      console.log(`[ablation:dedup] 臂A 主题覆盖@${K}=${mA.recallAtK.toFixed(2)}（去重后变体已弃用，FTS 兜底可触达全部主题）`);
      addRow("B.dedup", "dedup=on（臂A）", mA, msA, "主题覆盖@K；变体已合并");
      expect(mA.recallAtK).toBeGreaterThan(0.5);
    }, 300_000);

    it("臂 B（消融）：同内容重复入库且不 dedup → 召回多样性受损", async () => {
      // 臂 B 播种：同内容不同名 → 形成未去重的重复知识群
      await seedNodes(dupNodesB, SID_DUP_B);

      // 自检：redis 主题族当前活跃节点应 ≥ 4（臂A base + 臂B base/v1/v2）
      const session = getSession(driver);
      let redisActive = 0;
      try {
        const cnt = await session.run(
          `MATCH (n:Skill {status: 'active'})
           WHERE n.name STARTS WITH 'abl-redis' RETURN count(n) AS c`,
        );
        redisActive = cnt.records[0].get("c").toNumber();
      } finally { await session.close(); }
      console.log(`[ablation:dedup] 臂B 播种后 redis 族活跃节点 = ${redisActive}（应 ≥ 4：未去重副本在场）`);
      expect(redisActive).toBeGreaterThanOrEqual(4);

      const t0 = performance.now();
      const resB = await recallPipeline(DIVERSITY_QUERY, PRECISE_ONLY);
      const msB = performance.now() - t0;
      const mB = topicMetrics(resB);
      console.log(`[ablation:dedup] 臂B 主题覆盖@${K}=${mB.recallAtK.toFixed(2)}（向量 top-3 被同主题副本占据 → 其他主题挤不出种子）`);
      addRow("B.dedup", "dedup=off（臂B）", mB, msB, "主题覆盖@K；重复副本在场");
      expect(mB.recallAtK).toBeLessThan(1);
    }, 300_000);

    it("结论断言：dedup 提升召回主题多样性", async () => {
      // 从 ROWS 里取两臂的 recallAtK 对比（避免重复跑管线引入状态依赖）
      const rowA = ROWS.find((r) => r.suite === "B.dedup" && r.config.includes("臂A"));
      const rowB = ROWS.find((r) => r.suite === "B.dedup" && r.config.includes("臂B"));
      expect(rowA).toBeDefined();
      expect(rowB).toBeDefined();
      expect(Number(rowA!.recallAtK)).toBeGreaterThan(Number(rowB!.recallAtK));
    }, 30_000);
  });

  // ─── C. 衰减消融 ─────────────────────────────────────────

  describe("C. decay", () => {
    const DAY = 86_400_000;
    const STALE_QUERY = "kubernetes helm chart deployment rollout";
    const FRESH_QUERY = "rust tokio async runtime channels";

    const decayNodes: FixtureNode[] = [
      { key: "k8s-task", type: "TASK", name: "abl-k8s-rollout-automation", description: "kubernetes helm deployment automation", content: "helm charts template the kubernetes deployment, values overlays per cluster, helm upgrade rolls replicas with surge budget, rollback restores previous revision", topic: "stale" },
      { key: "k8s-helm", type: "SKILL", name: "abl-helm-chart-authoring", description: "helm chart authoring guide", content: "helm chart structure bundles templates, values and hooks; chart dependencies compose subcharts; kubeconform validates rendered manifests before the rollout applies", topic: "stale" },
      { key: "k8s-kubectl", type: "SKILL", name: "abl-kubectl-rollout-ops", description: "kubectl rollout operations", content: "kubectl rollout status watches deployment progress, rollout undo reverts the replica set, pod disruption budgets guard node drains during the rollout", topic: "stale" },
      { key: "k8s-event", type: "EVENT", name: "abl-helm-hook-incident", description: "helm hook incident notes", content: "a pre-upgrade helm hook deadlocked when jobs lacked ttl; the deployment rollout stalled until hook deletion policy and backoff limits were fixed", topic: "stale" },
      { key: "rust-task", type: "TASK", name: "abl-async-runtime-selection", description: "rust async runtime selection", content: "tokio drives the worker pool, multithreaded scheduler distributes tasks, io drivers poll sockets, rust futures compose selects and joins across the runtime", topic: "fresh" },
      { key: "rust-tokio", type: "SKILL", name: "abl-tokio-channel-patterns", description: "tokio channel patterns", content: "mpsc pipelines stages, broadcast fans out telemetry, oneshot awaits single replies, watch signals config reload across the async runtime", topic: "fresh" },
      { key: "rust-select", type: "SKILL", name: "abl-rust-select-timeouts", description: "rust select and timeouts", content: "tokio::select races futures, timeouts wrap slow branches, cancellation safety audits each arm, rust async blocks spawn detached from the parent scope", topic: "fresh" },
      { key: "rust-event", type: "EVENT", name: "abl-runtime-deadlock-retro", description: "async deadlock retrospective", content: "a mutex guard held across an await starved the tokio worker; restructuring critical sections and scoped channels unblocked the rust runtime", topic: "fresh" },
    ];

    const staleRelevant = () => new Set(["k8s-task", "k8s-helm", "k8s-kubectl", "k8s-event"]
      .map((k) => nodeRegistry.get(k)!.id));
    const freshRelevant = () => new Set(["rust-task", "rust-tokio", "rust-select", "rust-event"]
      .map((k) => nodeRegistry.get(k)!.id));

    async function setDecayProps(keys: string[], props: Record<string, number>): Promise<void> {
      const session = getSession(driver);
      try {
        for (const k of keys) {
          const node = nodeRegistry.get(k)!;
          const assignments = Object.keys(props)
            .map((p) => `n.${p} = $${p}`)
            .join(", ");
          await session.run(
            `MATCH (n:Task|Skill|Event {id: $id}) SET ${assignments}`,
            { id: node.id, ...props },
          );
        }
      } finally { await session.close(); }
    }

    beforeAll(async () => {
      await seedNodes(decayNodes, SID_DECAY);
      await seedEdges([
        { from: "k8s-task", to: "k8s-helm", type: "USED_SKILL", instruction: "rolls out with" },
        { from: "k8s-task", to: "k8s-kubectl", type: "USED_SKILL", instruction: "rolls out with" },
        { from: "k8s-helm", to: "k8s-kubectl", type: "REQUIRES", instruction: "gated by" },
        { from: "k8s-event", to: "k8s-helm", type: "SOLVED_BY", instruction: "mitigated by" },
        { from: "rust-task", to: "rust-tokio", type: "USED_SKILL", instruction: "runs on" },
        { from: "rust-task", to: "rust-select", type: "USED_SKILL", instruction: "runs on" },
        { from: "rust-tokio", to: "rust-select", type: "REQUIRES", instruction: "gated by" },
        { from: "rust-event", to: "rust-tokio", type: "SOLVED_BY", instruction: "mitigated by" },
      ], SID_DECAY);

      const now = Date.now();
      // 陈旧簇：120 天未访问、低频次 → 预期 peripheral + 自动弃用
      await setDecayProps(["k8s-task", "k8s-helm", "k8s-kubectl", "k8s-event"], {
        lastAccessedAt: now - 120 * DAY, updatedAt: now - 120 * DAY,
        createdAt: now - 200 * DAY, validatedCount: 1,
      });
      // 新鲜簇：活跃高频 → 预期保持 working/core
      await setDecayProps(["rust-task", "rust-tokio", "rust-select", "rust-event"], {
        validatedCount: 8,
      });

      // 手工指派社区 + Community 节点（不重跑全局检测，避免扰动 A 组社区）
      for (const [cid, keys, summary] of [
        ["abl-dec-stale", ["k8s-task", "k8s-helm", "k8s-kubectl", "k8s-event"], "kubernetes helm rollout knowledge"],
        ["abl-dec-fresh", ["rust-task", "rust-tokio", "rust-select", "rust-event"], "rust tokio async knowledge"],
      ] as Array<[string, string[], string]>) {
        const session = getSession(driver);
        try {
          await session.run(
            `MERGE (c:Community {id: $cid}) SET c.summary = $summary, c.nodeCount = $count`,
            { cid, summary, count: keys.length },
          );
          for (const k of keys) {
            await session.run(
              "MATCH (n:Task|Skill|Event {id: $id}) SET n.communityId = $cid",
              { id: nodeRegistry.get(k)!.id, cid },
            );
          }
        } finally { await session.close(); }
        await saveCommunityEmbedding(driver, cid,
          meanVector(keys.map((k) => buildNodeEmbeddingText(nodeRegistry.get(k)!))));
      }
    }, 120_000);

    it("arm0 基线：decay.enabled=false → 无扫描无弃用，陈旧知识仍可召回", async () => {
      const r = await applyDecay(driver, { decay: { ...DEFAULT_CONFIG.decay!, enabled: false } });
      expect(r.enabled).toBe(false);
      expect(r.autoDeprecated).toBe(0);

      const res = await recallPipeline(STALE_QUERY, FULL);
      const m = scoreResult(res, staleRelevant());
      console.log(`[ablation:decay] arm0 基线 recall@${K}=${m.recallAtK.toFixed(2)}`);
      expect(m.recallAtK).toBeGreaterThan(0);
      addRow("C.decay", "decay=off（基线）", m, 0, STALE_QUERY);
    }, 120_000);

    it("arm1 decay 开 + autoDeprecate 关：只降层不断联", async () => {
      const r = await applyDecay(driver, {
        decay: { ...DEFAULT_CONFIG.decay!, enabled: true, autoDeprecate: false },
      });
      console.log(`[ablation:decay] arm1 scanned=${r.scanned} transitions=${JSON.stringify(r.tierTransitions)} autoDeprecated=${r.autoDeprecated}`);
      expect(r.enabled).toBe(true);
      expect(r.autoDeprecated).toBe(0);
      // 120 天未访问 + validatedCount=1 的陈旧簇应降入 peripheral
      expect(r.tierTransitions.workingToPeripheral).toBeGreaterThanOrEqual(4);

      const res = await recallPipeline(STALE_QUERY, FULL);
      const m = scoreResult(res, staleRelevant());
      console.log(`[ablation:decay] arm1 陈旧查询 recall@${K}=${m.recallAtK.toFixed(2)}（未弃用，仍可达）`);
      expect(m.recallAtK).toBeGreaterThan(0);
      addRow("C.decay", "decay=on, autoDeprecate=off", m, 0, "降层但不断联");
    }, 120_000);

    it("arm2 全量 decay+autoDeprecate：陈旧簇被遗忘且新鲜簇不受影响", async () => {
      const r = await applyDecay(driver, {
        decay: { ...DEFAULT_CONFIG.decay!, enabled: true, autoDeprecate: true },
      });
      console.log(`[ablation:decay] arm2 autoDeprecated=${r.autoDeprecated}`);
      expect(r.autoDeprecated).toBeGreaterThanOrEqual(4);

      const session = getSession(driver);
      let decayDeprecated = 0;
      try {
        const cnt = await session.run(
          `MATCH (n:Task|Skill|Event)
           WHERE any(s IN n.sourceSessions WHERE s STARTS WITH $p)
             AND n.status = 'deprecated' AND n.deprecatedBy = 'decay'
           RETURN count(n) AS c`,
          { p: SID_DECAY },
        );
        decayDeprecated = cnt.records[0].get("c").toNumber();
      } finally { await session.close(); }
      expect(decayDeprecated).toBeGreaterThanOrEqual(4);

      const staleRes = await recallPipeline(STALE_QUERY, FULL);
      const staleM = scoreResult(staleRes, staleRelevant());
      console.log(`[ablation:decay] arm2 陈旧查询 recall@${K}=${staleM.recallAtK.toFixed(2)}（应为 0：已遗忘）`);

      const freshRes = await recallPipeline(FRESH_QUERY, FULL);
      const freshM = scoreResult(freshRes, freshRelevant());
      console.log(`[ablation:decay] arm2 新鲜查询 recall@${K}=${freshM.recallAtK.toFixed(2)}（应不受影响）`);

      addRow("C.decay", "decay+autoDeprecate=on（陈旧查询）", staleM, 0, "应遗忘 → 0");
      addRow("C.decay", "decay+autoDeprecate=on（新鲜查询）", freshM, 0, "对照：不应受损");
      expect(staleM.recallAtK).toBe(0);
      expect(freshM.recallAtK).toBeGreaterThan(0);
    }, 120_000);
  });

  // ─── D. 汇总报告 ─────────────────────────────────────────

  describe("D. report", () => {
    it("输出消融结果表 + JSON 工件", async () => {
      console.log("\n========== ABLATION STUDY RESULTS ==========");
      console.table(ROWS.map(({ suite, config, recallAtK, precisionAtK, mrr, nodes, latencyMs, note }) => ({
        suite, config, recallAt6: recallAtK, precisionAt6: precisionAtK, mrr, nodes, latencyMs, note,
      })));

      const outPath = fileURLToPath(new URL("../.zcode/ablation-results.json", import.meta.url));
      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        neo4jUri: NEO4J_URI,
        k: K,
        rows: ROWS,
      }, null, 2), "utf-8");
      console.log(`[ablation] JSON 工件已写入 ${outPath}`);
      expect(ROWS.length).toBeGreaterThan(0);
    }, 30_000);
  });
});
