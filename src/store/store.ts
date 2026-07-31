/**
 * graph-memory-pro — Neo4j 存储层
 *
 * 替代原版 SQLite store.ts
 * 所有操作改为 async，使用 Cypher 查询
 */

import type { Driver, Session } from "neo4j-driver";
import neo4j from "neo4j-driver";
import { createHash } from "crypto";
import type { GmNode, GmEdge, EdgeType, NodeType } from "../types.ts";
import { NODE_TYPE_TO_LABEL } from "../types.ts";
import { getSession } from "./db.ts";

/** Neo4j LIMIT/索引参数必须是 Integer */
function nint(v: number): any {
  return neo4j.int(Math.round(v));
}

// ─── 工具 ─────────────────────────────────────────────────────

function uid(p: string): string {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function toNode(r: any): GmNode {
  const n = r.properties ?? r;
  return {
    id: n.id,
    type: n.type,
    name: n.name,
    description: n.description ?? "",
    content: n.content,
    status: n.status,
    validatedCount: toInt(n.validatedCount ?? n.validated_count ?? 1),
    sourceSessions: typeof n.sourceSessions === "string"
      ? JSON.parse(n.sourceSessions)
      : (n.sourceSessions ?? []),
    communityId: n.communityId ?? null,
    pagerank: toFloat(n.pagerank ?? 0),
    createdAt: toInt(n.createdAt ?? n.created_at ?? 0),
    updatedAt: toInt(n.updatedAt ?? n.updated_at ?? 0),
  };
}

function toEdge(r: any): GmEdge {
  const e = r.properties ?? r;
  return {
    id: e.id,
    fromId: e.fromId ?? e.from_id,
    toId: e.toId ?? e.to_id,
    type: e.type,
    instruction: e.instruction,
    condition: e.condition ?? undefined,
    sessionId: e.sessionId ?? e.session_id,
    createdAt: toInt(e.createdAt ?? e.created_at ?? 0),
  };
}

/** Neo4j Integer → JS number */
function toInt(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  if (typeof v?.toNumber === "function") return v.toNumber();
  return Number(v) || 0;
}

function toFloat(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  if (typeof v?.toNumber === "function") return v.toNumber();
  return parseFloat(String(v)) || 0;
}

/** 标准化 name：全小写，空格转连字符，保留中文 */
function normalizeName(name: string): string {
  return name.trim().toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff\-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

export { normalizeName };

// ─── 节点 CRUD ───────────────────────────────────────────────

export async function findByName(driver: Driver, name: string): Promise<GmNode | null> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      "MATCH (n:Task|Skill|Event {name: $name}) RETURN n",
      { name: normalizeName(name) },
    );
    if (result.records.length === 0) return null;
    return toNode(result.records[0].get("n"));
  } finally {
    await session.close();
  }
}

export async function findById(driver: Driver, id: string): Promise<GmNode | null> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      "MATCH (n:Task|Skill|Event {id: $id}) RETURN n",
      { id },
    );
    if (result.records.length === 0) return null;
    return toNode(result.records[0].get("n"));
  } finally {
    await session.close();
  }
}

export async function allActiveNodes(driver: Driver): Promise<GmNode[]> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      "MATCH (n:Task|Skill|Event {status: 'active'}) RETURN n"
    );
    return result.records.map(r => toNode(r.get("n")));
  } finally {
    await session.close();
  }
}

export async function allEdges(driver: Driver): Promise<GmEdge[]> {
  const session = getSession(driver);
  try {
    const result = await session.run(`
      MATCH (a:Task|Skill|Event)-[r]->(b:Task|Skill|Event)
      WHERE type(r) IN ['USED_SKILL','SOLVED_BY','REQUIRES','PATCHES','CONFLICTS_WITH']
      RETURN r.id AS id, a.id AS fromId, b.id AS toId, type(r) AS type,
             r.instruction AS instruction, r.condition AS condition,
             r.sessionId AS sessionId, r.createdAt AS createdAt
    `);
    return result.records.map(r => ({
      id: r.get("id"),
      fromId: r.get("fromId"),
      toId: r.get("toId"),
      type: r.get("type") as EdgeType,
      instruction: r.get("instruction"),
      condition: r.get("condition") ?? undefined,
      sessionId: r.get("sessionId"),
      createdAt: toInt(r.get("createdAt")),
    }));
  } finally {
    await session.close();
  }
}

export async function upsertNode(
  driver: Driver,
  c: { type: NodeType; name: string; description: string; content: string },
  sessionId: string,
): Promise<{ node: GmNode; isNew: boolean }> {
  const name = normalizeName(c.name);
  const label = NODE_TYPE_TO_LABEL[c.type as NodeType] ?? "Skill";
  const session = getSession(driver);
  try {
    // Try to find existing node with this name across all knowledge labels
    const existing = await session.run(
      "MATCH (n:Task|Skill|Event {name: $name}) RETURN n",
      { name },
    );

    if (existing.records.length > 0) {
      // Update existing node
      await session.run(`
        MATCH (n:Task|Skill|Event {name: $name})
        SET n.content = CASE WHEN size($content) > size(n.content) THEN $content ELSE n.content END,
            n.description = CASE WHEN size($description) > size(n.description) THEN $description ELSE n.description END,
            n.validatedCount = n.validatedCount + 1,
            n.sourceSessions = CASE
              WHEN NOT $sessionId IN n.sourceSessions
              THEN n.sourceSessions + $sessionId
              ELSE n.sourceSessions
            END,
            n.updatedAt = $now
        RETURN n
      `, { name, content: c.content, description: c.description, sessionId, now: Date.now() });

      const updated = await session.run(
        "MATCH (n:Task|Skill|Event {name: $name}) RETURN n",
        { name },
      );
      return { node: toNode(updated.records[0].get("n")), isNew: false };
    } else {
      // Create new node with specific label
      const now = Date.now();
      const result = await session.run(`
        CREATE (n:MemoryNode:${label} {
          id: $id, name: $name, type: $type,
          description: $description, content: $content,
          status: 'active', validatedCount: 1,
          sourceSessions: $sessions, communityId: null,
          pagerank: 0.0, createdAt: $now, updatedAt: $now
        })
        RETURN n
      `, {
        id: uid("n"), name, type: c.type,
        description: c.description, content: c.content,
        sessions: [sessionId], now,
      });
      return { node: toNode(result.records[0].get("n")), isNew: true };
    }
  } finally {
    await session.close();
  }
}

export function applyNodePatch(
  ex: Pick<GmNode, "description" | "content">,
  patch: { description?: string; content?: string },
): { description: string; content: string } {
  return {
    description: patch.description ?? ex.description,
    content: patch.content ?? ex.content,
  };
}

/** 按 name 精确更新 description / content；找不到返回 null（调用方决定报错语义） */
export async function updateNode(
  driver: Driver,
  name: string,
  patch: { description?: string; content?: string },
): Promise<GmNode | null> {
  const ex = await findByName(driver, name);
  if (!ex) return null;
  const now = Date.now();
  const { description, content } = applyNodePatch(ex, patch);
  const session = getSession(driver);
  try {
    await session.run(
      `MATCH (n:Task|Skill|Event {id: $id})
       SET n.description = $description,
           n.content = $content,
           n.updatedAt = $now`,
      { id: ex.id, description, content, now },
    );
  } finally {
    await session.close();
  }
  return { ...ex, description, content, updatedAt: now };
}

export async function deprecate(driver: Driver, nodeId: string): Promise<void> {
  const session = getSession(driver);
  try {
    await session.run(
      "MATCH (n:Task|Skill|Event {id: $id}) SET n.status = 'deprecated', n.updatedAt = $now",
      { id: nodeId, now: Date.now() },
    );
  } finally {
    await session.close();
  }
}

/** 合并两个节点：keepId 保留，mergeId 标记 deprecated，边迁移 */
export async function mergeNodes(driver: Driver, keepId: string, mergeId: string): Promise<void> {
  const session = getSession(driver);
  try {
    await session.executeWrite(async tx => {
      // 合并属性
      await tx.run(`
        MATCH (keep:Task|Skill|Event {id: $keepId}), (merge:Task|Skill|Event {id: $mergeId})
        SET keep.validatedCount = keep.validatedCount + merge.validatedCount,
            keep.content = CASE WHEN size(keep.content) >= size(merge.content)
                           THEN keep.content ELSE merge.content END,
            keep.description = CASE WHEN size(keep.description) >= size(merge.description)
                               THEN keep.description ELSE merge.description END,
            keep.sourceSessions = apoc.coll.union(keep.sourceSessions, merge.sourceSessions),
            keep.updatedAt = $now
      `, { keepId, mergeId, now: Date.now() });

      // 迁移入边：指向 mergeId 的边改指向 keepId
      await tx.run(`
        MATCH (a:Task|Skill|Event)-[r]->(merge:Task|Skill|Event {id: $mergeId})
        WHERE a.id <> $keepId
        WITH a, r, type(r) AS rType, properties(r) AS props
        MATCH (keep:Task|Skill|Event {id: $keepId})
        CALL apoc.create.relationship(a, rType, props, keep) YIELD rel
        DELETE r
      `, { mergeId, keepId });

      // 迁移出边：从 mergeId 出发的边改从 keepId 出发
      await tx.run(`
        MATCH (merge:Task|Skill|Event {id: $mergeId})-[r]->(b:Task|Skill|Event)
        WHERE b.id <> $keepId
        WITH b, r, type(r) AS rType, properties(r) AS props
        MATCH (keep:Task|Skill|Event {id: $keepId})
        CALL apoc.create.relationship(keep, rType, props, b) YIELD rel
        DELETE r
      `, { mergeId, keepId });

      // 删除自环
      await tx.run(`
        MATCH (n:Task|Skill|Event {id: $keepId})-[r]->(n)
        DELETE r
      `, { keepId });

      // 标记 deprecated
      await tx.run(
        "MATCH (n:Task|Skill|Event {id: $mergeId}) SET n.status = 'deprecated', n.updatedAt = $now",
        { mergeId, now: Date.now() },
      );
    });
  } finally {
    await session.close();
  }
}

/** 批量更新 PageRank 分数 */
export async function updatePageranks(driver: Driver, scores: Map<string, number>): Promise<void> {
  if (scores.size === 0) return;
  const session = getSession(driver);
  try {
    const entries = Array.from(scores.entries()).map(([id, score]) => ({ id, score }));
    await session.run(`
      UNWIND $entries AS entry
      MATCH (n:Task|Skill|Event {id: entry.id})
      SET n.pagerank = entry.score
    `, { entries });
  } finally {
    await session.close();
  }
}

/** 批量更新社区 ID */
export async function updateCommunities(driver: Driver, labels: Map<string, string>): Promise<void> {
  if (labels.size === 0) return;
  const session = getSession(driver);
  try {
    const entries = Array.from(labels.entries()).map(([id, cid]) => ({ id, cid }));
    await session.run(`
      UNWIND $entries AS entry
      MATCH (n:Task|Skill|Event {id: entry.id})
      SET n.communityId = entry.cid
    `, { entries });
  } finally {
    await session.close();
  }
}

// ─── 边 CRUD ─────────────────────────────────────────────────

export async function upsertEdge(
  driver: Driver,
  e: { fromId: string; toId: string; type: EdgeType; instruction: string; condition?: string; sessionId: string },
): Promise<void> {
  const session = getSession(driver);
  try {
    // 检查是否已存在同 from+to+type 的边
    const existing = await session.run(`
      MATCH (a:Task|Skill|Event {id: $fromId})-[r]->(b:Task|Skill|Event {id: $toId})
      WHERE type(r) = $type
      RETURN r
    `, { fromId: e.fromId, toId: e.toId, type: e.type });

    if (existing.records.length > 0) {
      await session.run(`
        MATCH (a:Task|Skill|Event {id: $fromId})-[r]->(b:Task|Skill|Event {id: $toId})
        WHERE type(r) = $type
        SET r.instruction = $instruction
      `, { fromId: e.fromId, toId: e.toId, type: e.type, instruction: e.instruction });
    } else {
      // 用 APOC 动态创建关系（type 是变量）
      await session.run(`
        MATCH (a:Task|Skill|Event {id: $fromId}), (b:Task|Skill|Event {id: $toId})
        CALL apoc.create.relationship(a, $type, {
          id: $id,
          instruction: $instruction,
          condition: $condition,
          sessionId: $sessionId,
          createdAt: $now
        }, b) YIELD rel
        RETURN rel
      `, {
        fromId: e.fromId,
        toId: e.toId,
        type: e.type,
        id: uid("e"),
        instruction: e.instruction,
        condition: e.condition ?? null,
        sessionId: e.sessionId,
        now: Date.now(),
      });
    }
  } finally {
    await session.close();
  }
}

export async function edgesFrom(driver: Driver, id: string): Promise<GmEdge[]> {
  const session = getSession(driver);
  try {
    const result = await session.run(`
      MATCH (a:Task|Skill|Event {id: $id})-[r]->(b:Task|Skill|Event)
      WHERE type(r) IN ['USED_SKILL','SOLVED_BY','REQUIRES','PATCHES','CONFLICTS_WITH']
      RETURN r.id AS id, a.id AS fromId, b.id AS toId, type(r) AS type,
             r.instruction AS instruction, r.condition AS condition,
             r.sessionId AS sessionId, r.createdAt AS createdAt
    `, { id });
    return result.records.map(r => ({
      id: r.get("id"),
      fromId: r.get("fromId"),
      toId: r.get("toId"),
      type: r.get("type") as EdgeType,
      instruction: r.get("instruction"),
      condition: r.get("condition") ?? undefined,
      sessionId: r.get("sessionId"),
      createdAt: toInt(r.get("createdAt")),
    }));
  } finally {
    await session.close();
  }
}

export async function edgesTo(driver: Driver, id: string): Promise<GmEdge[]> {
  const session = getSession(driver);
  try {
    const result = await session.run(`
      MATCH (a:Task|Skill|Event)-[r]->(b:Task|Skill|Event {id: $id})
      WHERE type(r) IN ['USED_SKILL','SOLVED_BY','REQUIRES','PATCHES','CONFLICTS_WITH']
      RETURN r.id AS id, a.id AS fromId, b.id AS toId, type(r) AS type,
             r.instruction AS instruction, r.condition AS condition,
             r.sessionId AS sessionId, r.createdAt AS createdAt
    `, { id });
    return result.records.map(r => ({
      id: r.get("id"),
      fromId: r.get("fromId"),
      toId: r.get("toId"),
      type: r.get("type") as EdgeType,
      instruction: r.get("instruction"),
      condition: r.get("condition") ?? undefined,
      sessionId: r.get("sessionId"),
      createdAt: toInt(r.get("createdAt")),
    }));
  } finally {
    await session.close();
  }
}

// ─── 搜索 ───────────────────────────────────────────────────

/** 全文搜索节点（CONTAINS 模糊匹配） */
export async function searchNodes(driver: Driver, query: string, limit = 6): Promise<GmNode[]> {
  const terms = query.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!terms.length) return topNodes(driver, limit);

  const session = getSession(driver);
  try {
    // 用 CONTAINS 做模糊匹配（Neo4j 没有原生 FTS5，但够用）
    const where = terms.map((_, i) => `(
      toLower(n.name) CONTAINS toLower($t${i}) OR
      toLower(n.description) CONTAINS toLower($t${i}) OR
      toLower(n.content) CONTAINS toLower($t${i})
    )`).join(" OR ");

    const params: Record<string, any> = { limit: nint(limit) };
    terms.forEach((t, i) => { params[`t${i}`] = t; });

    const result = await session.run(`
      MATCH (n:Task|Skill|Event {status: 'active'})
      WHERE ${where}
      RETURN n
      ORDER BY n.pagerank DESC, n.validatedCount DESC, n.updatedAt DESC
      LIMIT toInteger($limit)
    `, params);

    return result.records.map(r => toNode(r.get("n")));
  } finally {
    await session.close();
  }
}

/** 热门节点 */
export async function topNodes(driver: Driver, limit = 6): Promise<GmNode[]> {
  const session = getSession(driver);
  try {
    const result = await session.run(`
      MATCH (n:Task|Skill|Event {status: 'active'})
      RETURN n
      ORDER BY n.pagerank DESC, n.validatedCount DESC, n.updatedAt DESC
      LIMIT toInteger($limit)
    `, { limit: nint(limit) });
    return result.records.map(r => toNode(r.get("n")));
  } finally {
    await session.close();
  }
}

// ─── 向量搜索 ───────────────────────────────────────────────

export type ScoredNode = { node: GmNode; score: number };

export async function vectorSearchWithScore(
  driver: Driver, queryVec: number[], limit: number, minScore = 0.35,
): Promise<ScoredNode[]> {
  const session = getSession(driver);
  try {
    const result = await session.run(`
      CALL db.index.vector.queryNodes('gm_node_embedding', $limit, $vec)
      YIELD node, score
      WHERE node.status = 'active' AND score > $minScore
      RETURN node, score
      ORDER BY score DESC
    `, { vec: queryVec, limit: nint(limit), minScore });

    return result.records.map(r => ({
      node: toNode(r.get("node")),
      score: toFloat(r.get("score")),
    }));
  } finally {
    await session.close();
  }
}

export async function vectorSearch(
  driver: Driver, queryVec: number[], limit: number, minScore = 0.35,
): Promise<GmNode[]> {
  const scored = await vectorSearchWithScore(driver, queryVec, limit, minScore);
  return scored.map(s => s.node);
}

/** 社区向量搜索 */
export type ScoredCommunity = { id: string; summary: string; score: number; nodeCount: number };

export async function communityVectorSearch(
  driver: Driver, queryVec: number[], minScore = 0.15,
): Promise<ScoredCommunity[]> {
  const session = getSession(driver);
  try {
    const result = await session.run(`
      CALL db.index.vector.queryNodes('gm_community_embedding', 10, $vec)
      YIELD node, score
      WHERE score > $minScore
      RETURN node.id AS id, node.summary AS summary, score, node.nodeCount AS nodeCount
      ORDER BY score DESC
    `, { vec: queryVec, minScore });

    return result.records.map(r => ({
      id: r.get("id"),
      summary: r.get("summary"),
      score: toFloat(r.get("score")),
      nodeCount: toInt(r.get("nodeCount")),
    }));
  } finally {
    await session.close();
  }
}

// ─── 向量存储 ───────────────────────────────────────────────

export async function saveVector(driver: Driver, nodeId: string, content: string, vec: number[]): Promise<void> {
  const hash = createHash("md5").update(content).digest("hex");
  const session = getSession(driver);
  try {
    await session.run(`
      MATCH (n:Task|Skill|Event {id: $nodeId})
      SET n.embedding = $vec, n.contentHash = $hash
    `, { nodeId, vec, hash });
  } finally {
    await session.close();
  }
}

export async function getVectorHash(driver: Driver, nodeId: string): Promise<string | null> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      "MATCH (n:Task|Skill|Event {id: $nodeId}) RETURN n.contentHash AS hash",
      { nodeId },
    );
    return result.records[0]?.get("hash") ?? null;
  } finally {
    await session.close();
  }
}

/** 获取所有有向量的活跃节点（供去重用） */
export async function getAllVectors(driver: Driver): Promise<Array<{ nodeId: string; embedding: number[] }>> {
  const session = getSession(driver);
  try {
    const result = await session.run(`
      MATCH (n:Task|Skill|Event {status: 'active'})
      WHERE n.embedding IS NOT NULL
      RETURN n.id AS nodeId, n.embedding AS embedding
    `);
    return result.records.map(r => ({
      nodeId: r.get("nodeId"),
      embedding: r.get("embedding"),
    }));
  } finally {
    await session.close();
  }
}

// ─── 图遍历 ────────────────────────────────────────────────

export async function graphWalk(
  driver: Driver,
  seedIds: string[],
  maxDepth: number,
): Promise<{ nodes: GmNode[]; edges: GmEdge[] }> {
  if (!seedIds.length) return { nodes: [], edges: [] };

  const session = getSession(driver);
  try {
    // 用 Neo4j 的变长路径匹配做图遍历
    const nodeResult = await session.run(`
      MATCH (seed:Task|Skill|Event)
      WHERE seed.id IN $seedIds AND seed.status = 'active'
      CALL {
        WITH seed
        MATCH path = (seed)-[*0..${maxDepth}]-(neighbor:Task|Skill|Event {status: 'active'})
        RETURN DISTINCT neighbor
      }
      RETURN DISTINCT neighbor AS n
    `, { seedIds });

    const nodes = nodeResult.records.map(r => toNode(r.get("n")));
    const nodeIds = nodes.map(n => n.id);

    if (!nodeIds.length) return { nodes: [], edges: [] };

    const edgeResult = await session.run(`
      MATCH (a:Task|Skill|Event)-[r]->(b:Task|Skill|Event)
      WHERE a.id IN $nodeIds AND b.id IN $nodeIds
        AND type(r) IN ['USED_SKILL','SOLVED_BY','REQUIRES','PATCHES','CONFLICTS_WITH']
      RETURN r.id AS id, a.id AS fromId, b.id AS toId, type(r) AS type,
             r.instruction AS instruction, r.condition AS condition,
             r.sessionId AS sessionId, r.createdAt AS createdAt
    `, { nodeIds });

    const edges = edgeResult.records.map(r => ({
      id: r.get("id"),
      fromId: r.get("fromId"),
      toId: r.get("toId"),
      type: r.get("type") as EdgeType,
      instruction: r.get("instruction"),
      condition: r.get("condition") ?? undefined,
      sessionId: r.get("sessionId"),
      createdAt: toInt(r.get("createdAt")),
    }));

    return { nodes, edges };
  } finally {
    await session.close();
  }
}

// ─── 按 session 查询 ────────────────────────────────────────

export async function getBySession(driver: Driver, sessionId: string): Promise<GmNode[]> {
  const session = getSession(driver);
  try {
    const result = await session.run(`
      MATCH (n:Task|Skill|Event {status: 'active'})
      WHERE $sessionId IN n.sourceSessions
      RETURN n
    `, { sessionId });
    return result.records.map(r => toNode(r.get("n")));
  } finally {
    await session.close();
  }
}

// ─── 社区代表节点 ──────────────────────────────────────────

export async function communityRepresentatives(driver: Driver, perCommunity = 2): Promise<GmNode[]> {
  const session = getSession(driver);
  try {
    const result = await session.run(`
      MATCH (n:Task|Skill|Event {status: 'active'})
      WHERE n.communityId IS NOT NULL
      WITH n.communityId AS cid, n
      ORDER BY n.updatedAt DESC
      WITH cid, collect(n) AS members
      UNWIND members[0..toInteger($perCommunity)] AS m
      RETURN m AS n
    `, { perCommunity });
    return result.records.map(r => toNode(r.get("n")));
  } finally {
    await session.close();
  }
}

export async function nodesByCommunityIds(driver: Driver, communityIds: string[], perCommunity = 3): Promise<GmNode[]> {
  if (!communityIds.length) return [];
  const session = getSession(driver);
  try {
    const result = await session.run(`
      MATCH (n:Task|Skill|Event {status: 'active'})
      WHERE n.communityId IN $communityIds
      WITH n.communityId AS cid, n
      ORDER BY n.updatedAt DESC
      WITH cid, collect(n) AS members
      UNWIND members[0..toInteger($perCommunity)] AS m
      RETURN m AS n
    `, { communityIds, perCommunity });
    return result.records.map(r => toNode(r.get("n")));
  } finally {
    await session.close();
  }
}

// ─── 消息 CRUD ───────────────────────────────────────────────

export async function saveMessage(
  driver: Driver, sid: string, turn: number, role: string, content: unknown,
): Promise<void> {
  const session = getSession(driver);
  try {
    await session.run(`
      MERGE (m:GmMessage {sessionId: $sid, turnIndex: $turn})
      ON CREATE SET
        m.id = $id,
        m.role = $role,
        m.content = $content,
        m.extracted = false,
        m.createdAt = $now
    `, {
      id: uid("m"),
      sid,
      turn,
      role,
      content: JSON.stringify(content),
      now: Date.now(),
    });
  } finally {
    await session.close();
  }
}

export async function getUnextracted(driver: Driver, sid: string, limit: number): Promise<any[]> {
  const session = getSession(driver);
  try {
    const result = await session.run(`
      MATCH (m:GmMessage {sessionId: $sid, extracted: false})
      RETURN m
      ORDER BY m.turnIndex
      LIMIT toInteger($limit)
    `, { sid, limit: nint(limit) });
    return result.records.map(r => {
      const m = r.get("m").properties;
      return {
        role: m.role,
        content: JSON.parse(m.content),
        turnIndex: toInt(m.turnIndex),
        turn_index: toInt(m.turnIndex),
      };
    });
  } finally {
    await session.close();
  }
}

export async function markExtracted(driver: Driver, sid: string, upToTurn: number): Promise<void> {
  const session = getSession(driver);
  try {
    await session.run(`
      MATCH (m:GmMessage {sessionId: $sid})
      WHERE m.turnIndex <= $upToTurn
      SET m.extracted = true
    `, { sid, upToTurn });
  } finally {
    await session.close();
  }
}

export async function isTurnExtracted(driver: Driver, sid: string, turn: number): Promise<boolean> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      `MATCH (m:GmMessage {sessionId: $sid, turnIndex: $turn, extracted: true})
       RETURN count(m) AS c`,
      { sid, turn },
    );
    return toInt(result.records[0].get("c")) > 0;
  } finally {
    await session.close();
  }
}

// ─── 信号 CRUD ───────────────────────────────────────────────

// ─── 统计 ────────────────────────────────────────────────────

export async function getStats(driver: Driver): Promise<{
  totalNodes: number;
  byType: Record<string, number>;
  totalEdges: number;
  byEdgeType: Record<string, number>;
  communities: number;
}> {
  const session = getSession(driver);
  try {
    const byTypeResult = await session.run(`
      MATCH (n:Task|Skill|Event {status: 'active'})
      RETURN n.type AS type, count(n) AS c
    `);
    const totalResult = await session.run(
      "MATCH (n:Task|Skill|Event {status: 'active'}) RETURN count(n) AS c"
    );
    const totalNodes = toInt(totalResult.records[0]?.get("c") ?? 0);

    const byType: Record<string, number> = {};
    for (const r of byTypeResult.records) {
      byType[r.get("type")] = toInt(r.get("c"));
    }

    const edgeResult = await session.run(`
      MATCH ()-[r]->()
      WHERE type(r) IN ['USED_SKILL','SOLVED_BY','REQUIRES','PATCHES','CONFLICTS_WITH']
      RETURN type(r) AS type, count(r) AS c
    `);
    let totalEdges = 0;
    const byEdgeType: Record<string, number> = {};
    for (const r of edgeResult.records) {
      const c = toInt(r.get("c"));
      byEdgeType[r.get("type")] = c;
      totalEdges += c;
    }

    const commResult = await session.run(`
      MATCH (n:Task|Skill|Event {status: 'active'})
      WHERE n.communityId IS NOT NULL
      RETURN count(DISTINCT n.communityId) AS c
    `);
    const communities = toInt(commResult.records[0]?.get("c") ?? 0);

    return { totalNodes, byType, totalEdges, byEdgeType, communities };
  } finally {
    await session.close();
  }
}

// ─── 社区描述 CRUD ──────────────────────────────────────────

export interface CommunitySummary {
  id: string;
  summary: string;
  nodeCount: number;
  createdAt: number;
  updatedAt: number;
}

export async function upsertCommunitySummary(
  driver: Driver, id: string, summary: string, nodeCount: number, embedding?: number[],
): Promise<void> {
  const session = getSession(driver);
  try {
    await session.run(`
      MERGE (c:Community {id: $id})
      ON CREATE SET
        c.summary = $summary,
        c.nodeCount = $nodeCount,
        c.embedding = $embedding,
        c.createdAt = $now,
        c.updatedAt = $now
      ON MATCH SET
        c.summary = $summary,
        c.nodeCount = $nodeCount,
        c.embedding = CASE WHEN $embedding IS NOT NULL THEN $embedding ELSE c.embedding END,
        c.updatedAt = $now
    `, {
      id,
      summary,
      nodeCount,
      embedding: embedding ?? null,
      now: Date.now(),
    });
  } finally {
    await session.close();
  }
}

export async function getCommunitySummary(driver: Driver, id: string): Promise<CommunitySummary | null> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      "MATCH (c:Community {id: $id}) RETURN c",
      { id },
    );
    if (result.records.length === 0) return null;
    const c = result.records[0].get("c").properties;
    return {
      id: c.id,
      summary: c.summary,
      nodeCount: toInt(c.nodeCount),
      createdAt: toInt(c.createdAt),
      updatedAt: toInt(c.updatedAt),
    };
  } finally {
    await session.close();
  }
}

export async function getAllCommunitySummaries(driver: Driver): Promise<CommunitySummary[]> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      "MATCH (c:Community) RETURN c ORDER BY c.nodeCount DESC"
    );
    return result.records.map(r => {
      const c = r.get("c").properties;
      return {
        id: c.id,
        summary: c.summary,
        nodeCount: toInt(c.nodeCount),
        createdAt: toInt(c.createdAt),
        updatedAt: toInt(c.updatedAt),
      };
    });
  } finally {
    await session.close();
  }
}

export async function pruneCommunitySummaries(driver: Driver): Promise<number> {
  const session = getSession(driver);
  try {
    const result = await session.run(`
      MATCH (c:Community)
      WHERE NOT EXISTS {
        MATCH (n:Task|Skill|Event {status: 'active'})
        WHERE n.communityId = c.id
      }
      DELETE c
      RETURN count(*) AS deleted
    `);
    return toInt(result.records[0]?.get("deleted") ?? 0);
  } finally {
    await session.close();
  }
}
