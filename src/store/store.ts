/**
 * graph-memory-pro — Neo4j 存储层
 *
 * 替代原版 SQLite store.ts
 * 所有操作改为 async，使用 Cypher 查询
 */

import type { Driver } from "neo4j-driver";
import neo4j from "neo4j-driver";
import { createHash, randomUUID } from "crypto";
import type { GmNode, GmEdge, EdgeType, NodeType, NodeTier, DeprecatedBy } from "../types.ts";
import { NODE_TYPE_TO_LABEL, isValidEdgeDirection, EDGE_TYPES } from "../types.ts";
import { getSession } from "./db.ts";

/** Neo4j LIMIT/索引参数必须是 Integer */
function nint(v: number): any {
  return neo4j.int(Math.round(v));
}

// ─── 工具 ─────────────────────────────────────────────────────

function uid(p: string): string {
  return `${p}-${randomUUID()}`;
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
    tier: (n.tier === "core" || n.tier === "working" || n.tier === "peripheral"
      ? n.tier : "working") as NodeTier,
    validatedCount: toInt(n.validatedCount ?? n.validated_count ?? 1),
    sourceSessions: typeof n.sourceSessions === "string"
      ? JSON.parse(n.sourceSessions)
      : (n.sourceSessions ?? []),
    communityId: n.communityId ?? null,
    pagerank: toFloat(n.pagerank ?? 0),
    createdAt: toInt(n.createdAt ?? n.created_at ?? 0),
    updatedAt: toInt(n.updatedAt ?? n.updated_at ?? 0),
    lastAccessedAt: toInt(n.lastAccessedAt ?? n.last_accessed_at ?? n.updatedAt ?? n.updated_at ?? n.createdAt ?? 0),
    decayScore: typeof n.decayScore === "number" ? n.decayScore : undefined,
    decayComputedAt: n.decayComputedAt ? toInt(n.decayComputedAt) : undefined,
    deprecatedAt: n.deprecatedAt != null ? toInt(n.deprecatedAt) : undefined,
    deprecatedBy: n.deprecatedBy != null ? (n.deprecatedBy as DeprecatedBy) : undefined,
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

// ─── 边行读取（单一来源）─────────────────────────────────────
// 知识边类型白名单的 Cypher 片段与 RETURN 投影/记录映射只在此定义，
// allEdges/edgesFrom/edgesTo/edgesTouching/graphWalk/getStats 共用 ——
// 新增 EdgeType 时只改 types.ts 的 EDGE_TYPES，勿在 Cypher 里内联字面量。

const EDGE_TYPE_FILTER = `type(r) IN ${JSON.stringify([...EDGE_TYPES])}`;

const EDGE_ROW_RETURN = `
      RETURN r.id AS id, a.id AS fromId, b.id AS toId, type(r) AS type,
             r.instruction AS instruction, r.condition AS condition,
             r.sessionId AS sessionId, r.createdAt AS createdAt`;

type EdgeRowResult = { records: Array<{ get(key: string): any }> };

/** 边行记录 → GmEdge（与 EDGE_ROW_RETURN 投影一一对应） */
function mapEdgeRecords(result: EdgeRowResult): GmEdge[] {
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
}

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
      WHERE ${EDGE_TYPE_FILTER}${EDGE_ROW_RETURN}
    `);
    return mapEdgeRecords(result);
  } finally {
    await session.close();
  }
}

/** 判断错误是否为 *_name 唯一约束冲突（CREATE 撞上并发创建时用于幂等回退） */
function isNameConstraintViolation(err: unknown): boolean {
  const s = String(err);
  return s.includes("ConstraintValidationFailed") || s.includes("already exists with label");
}

export async function upsertNode(
  driver: Driver,
  c: { type: NodeType; name: string; description: string; content: string },
  sessionId: string,
): Promise<{ node: GmNode; isNew: boolean }> {
  const name = normalizeName(c.name);
  const label = NODE_TYPE_TO_LABEL[c.type as NodeType];
  if (!label) throw new Error(`[graph-memory-pro] Invalid node type: ${String(c.type)}`);
  const session = getSession(driver);
  /** 按 name 更新已存在节点（find 命中与撞约束回退两条路径共用） */
  const updateExisting = async (): Promise<{ node: GmNode; isNew: boolean }> => {
    // revived：decay 自动弃用的节点被重新提取命中时自动复活（manual/merge 弃用不复活）。
    // revived 分支剥掉 [DEPRECATED] 前缀并忽略本次 description（语义与 stripDeprecateMarker 一致：
    // 仅匹配 "[DEPRECATED] " 前缀或裸 "[DEPRECATED]" 整串，避免误伤恰以该子串开头的原文）。
    // REMOVE 只对 revived 行执行——manual/merge 节点必须保留 deprecatedAt/By，
    // 否则既丢弃用溯源，purge 时钟又会回退到本查询刚写入的 updatedAt（无限续命）。
    await session.run(`
      MATCH (n:Task|Skill|Event {name: $name})
      WITH n, (n.status = 'deprecated' AND coalesce(n.deprecatedBy, 'manual') = 'decay') AS revived
      SET n.content = CASE WHEN size($content) > size(n.content) THEN $content ELSE n.content END,
          n.description = CASE
            WHEN revived AND n.description STARTS WITH '[DEPRECATED] '
              THEN substring(n.description, size('[DEPRECATED] '))
            WHEN revived AND n.description = '[DEPRECATED]'
              THEN ''
            WHEN size($description) > size(n.description) THEN $description
            ELSE n.description
          END,
          n.status = CASE WHEN revived THEN 'active' ELSE n.status END,
          n.validatedCount = n.validatedCount + 1,
          n.sourceSessions = CASE
            WHEN NOT $sessionId IN n.sourceSessions
            THEN n.sourceSessions + $sessionId
            ELSE n.sourceSessions
          END,
          n.lastAccessedAt = $now,
          n.updatedAt = $now
      FOREACH (_ IN CASE WHEN revived THEN [1] ELSE [] END
        | REMOVE n.deprecatedAt, n.deprecatedBy)
      RETURN n
    `, { name, content: c.content, description: c.description, sessionId, now: Date.now() });

    const updated = await session.run(
      "MATCH (n:Task|Skill|Event {name: $name}) RETURN n",
      { name },
    );
    // 撞约束回退路径存在窄窗口：并发创建的同名节点可能在 MATCH 前被删除
    //（如 maintenance mergeNodes）——守卫让单个节点失败而不是 TypeError 炸整批
    const record = updated.records[0]?.get("n");
    if (!record) {
      throw new Error(`[graph-memory-pro] upsertNode: node "${name}" disappeared during update`);
    }
    return { node: toNode(record), isNew: false };
  };
  try {
    // Try to find existing node with this name across all knowledge labels
    const existing = await session.run(
      "MATCH (n:Task|Skill|Event {name: $name}) RETURN n",
      { name },
    );

    if (existing.records.length > 0) {
      // 必须 return await：否则 finally 的 session.close() 会与闭包内的
      // 第二次 session.run 竞态（closed session 错误）
      return await updateExisting();
    }
    // Create new node with specific label
    try {
      const now = Date.now();
      const result = await session.run(`
        CREATE (n:MemoryNode:${label} {
          id: $id, name: $name, type: $type,
          description: $description, content: $content,
          status: 'active', tier: 'working', validatedCount: 1,
          sourceSessions: $sessions, communityId: null,
          pagerank: 0.0, createdAt: $now, updatedAt: $now,
          lastAccessedAt: $now
        })
        RETURN n
      `, {
        id: uid("n"), name, type: c.type,
        description: c.description, content: c.content,
        sessions: [sessionId], now,
      });
      return { node: toNode(result.records[0].get("n")), isNew: true };
    } catch (err) {
      // find-then-create 窗口内并发路径抢先创建了同名节点（撞 *_name 唯一约束）
      // → 退回更新路径保持幂等，而不是让整轮提取失败重试
      if (isNameConstraintViolation(err)) return await updateExisting();
      throw err;
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
  // decay 自动弃用的节点被手动编辑命中 → 顺手复活（manual/merge 弃用不复活）。
  // REMOVE 仅在复活时执行：非复活节点保留 deprecatedAt/By（溯源 + purge 时钟不被重置）。
  const revived = ex.status === "deprecated" && (ex.deprecatedBy ?? "manual") === "decay";
  const finalDescription = revived ? stripDeprecateMarker(description) : description;
  const session = getSession(driver);
  try {
    await session.run(
      `MATCH (n:Task|Skill|Event {id: $id})
       SET n.description = $description,
           n.content = $content,
           n.status = $status,
           n.updatedAt = $now
       ${revived ? "REMOVE n.deprecatedAt, n.deprecatedBy" : ""}`,
      { id: ex.id, description: finalDescription, content, status: revived ? "active" : ex.status, now },
    );
  } finally {
    await session.close();
  }
  return {
    ...ex,
    description: finalDescription,
    content,
    updatedAt: now,
    status: revived ? "active" : ex.status,
    ...(revived ? { deprecatedAt: undefined, deprecatedBy: undefined } : {}),
  };
}

/**
 * 给描述加上 [DEPRECATED] 前缀；已存在则原样返回。
 * 抽成纯函数便于单元测试（Cypher 路径在 integration test 覆盖）。
 */
export function applyDeprecateMarker(description: string): string {
  const prefix = "[DEPRECATED]";
  if (!description) return prefix;
  if (description.startsWith(prefix)) return description;
  return `${prefix} ${description}`;
}

/**
 * 剥掉 [DEPRECATED] 前缀（applyDeprecateMarker 的逆操作）——
 * decay 自动弃用的节点复活时还原描述。无前缀则原样返回。
 */
export function stripDeprecateMarker(description: string): string {
  const prefix = "[DEPRECATED]";
  if (description === prefix) return "";
  if (description.startsWith(`${prefix} `)) return description.slice(prefix.length + 1);
  return description;
}

/**
 * 手动弃用（一次性断联，按 id 定位）：status='deprecated' + deprecatedAt/deprecatedBy='manual'
 * + 描述加 [DEPRECATED] 前缀 + 删除所有边。所有人工路径（gm_update mode=deprecate、
 * finalize invalidations、REST DELETE）统一走这里。
 * deprecated 节点对所有召回路径不可见且无边可走，效果等同删除；仅保留 purgeAfterDays
 * （默认 60 天）反悔窗口，到期由 maintenance 硬删。找不到返回 null。
 */
export async function deprecateNodeAndDisconnectById(
  driver: Driver,
  id: string,
  now: number = Date.now(),
): Promise<GmNode | null> {
  const ex = await findById(driver, id);
  if (!ex) return null;
  // 已弃用节点再次被弃用时保留原 deprecatedAt——否则每次重新提取触发的
  // finalize invalidations / REST 重试都会重置 60 天 purge 时钟（无限续命）。
  const deprecatedAt = ex.status === "deprecated" && ex.deprecatedAt ? ex.deprecatedAt : now;
  const description = applyDeprecateMarker(ex.description);
  const session = getSession(driver);
  try {
    await session.run(
      `MATCH (n:Task|Skill|Event {id: $id})
       SET n.status = 'deprecated',
           n.deprecatedAt = $deprecatedAt,
           n.deprecatedBy = 'manual',
           n.description = $description,
           n.updatedAt = $now
       WITH n
       OPTIONAL MATCH (n)-[r]-()
       DELETE r`,
      { id, deprecatedAt, description, now },
    );
  } finally {
    await session.close();
  }
  return { ...ex, status: "deprecated", deprecatedAt, deprecatedBy: "manual", description, updatedAt: now };
}

/** 按 name 弃用并切断（gm_update mode=deprecate 用）；找不到返回 null。 */
export async function deprecateNodeAndDisconnect(
  driver: Driver,
  name: string,
): Promise<GmNode | null> {
  const ex = await findByName(driver, name);
  if (!ex) return null;
  return deprecateNodeAndDisconnectById(driver, ex.id, Date.now());
}

/**
 * 遗忘曲线自动弃用（两阶段生命周期·阶段一）：批量 status='deprecated' + deprecatedBy='decay'
 * + 描述幂等加 [DEPRECATED] 前缀 + 切断所有边。与 deprecateNodeAndDisconnect 的区别：
 * 按 id 批量、来源标记 decay（重新提取/编辑命中时可被 upsertNode/updateNode 复活）。
 * MATCH 带状态守卫：ids 来自 applyDecay 的 active 扫描快照，评分与批量写入之间存在
 * 时间窗——窗口内刚被手动弃用的节点不得被覆盖为 decay（既改变复活语义又重置 purge 时钟），
 * 因此只弃用仍为 active 的节点。返回实际弃用的节点数。
 */
export async function autoDeprecateNodes(
  driver: Driver,
  ids: string[],
  now: number = Date.now(),
): Promise<number> {
  if (!ids.length) return 0;
  const session = getSession(driver);
  try {
    const result = await session.run(`
      UNWIND $ids AS nid
      MATCH (n:Task|Skill|Event {id: nid, status: 'active'})
      SET n.status = 'deprecated',
          n.deprecatedAt = $now,
          n.deprecatedBy = 'decay',
          n.description = CASE
            WHEN n.description STARTS WITH '[DEPRECATED]' THEN n.description
            WHEN n.description IS NULL OR size(n.description) = 0 THEN '[DEPRECATED]'
            ELSE '[DEPRECATED] ' + n.description
          END,
          n.updatedAt = $now
      WITH n
      OPTIONAL MATCH (n)-[r]-()
      DELETE r
      RETURN count(DISTINCT n) AS c
    `, { ids, now });
    return toInt(result.records[0]?.get("c") ?? 0);
  } finally {
    await session.close();
  }
}

/**
 * 两阶段生命周期·阶段二：硬删过期 deprecated 节点（DETACH DELETE，embedding/contentHash
 * 向量属性随节点一并移除，释放存储）。时钟基准 deprecatedAt；coalesce 回退 updatedAt 仅是
 * 防御性兜底——initSchema 启动时已为存量 deprecated 节点一次性补写 deprecatedAt（否则
 * upsertNode 对 manual/merge 弃用节点的 updatedAt bump 会无限推迟 purge）。
 * 适用于所有 deprecated 节点（decay/manual/merge）；purgeAfterMs<=0 时为 no-op。返回删除数。
 */
export async function purgeDeprecatedNodes(
  driver: Driver,
  purgeAfterMs: number,
  now: number = Date.now(),
): Promise<number> {
  if (!(purgeAfterMs > 0)) return 0;
  const session = getSession(driver);
  try {
    const result = await session.run(`
      MATCH (n:Task|Skill|Event {status: 'deprecated'})
      WHERE coalesce(n.deprecatedAt, n.updatedAt) < $cutoff
      DETACH DELETE n
      RETURN count(n) AS c
    `, { cutoff: now - purgeAfterMs });
    return toInt(result.records[0]?.get("c") ?? 0);
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

      // 迁移入边：指向 mergeId 的边改指向 keepId（去重——keep 已有同类型边则直接丢弃原边）
      await tx.run(`
        MATCH (a:Task|Skill|Event)-[r]->(merge:Task|Skill|Event {id: $mergeId})
        WHERE a.id <> $keepId
          AND EXISTS {
            MATCH (keep:Task|Skill|Event {id: $keepId}), (a)-[dup]->(keep)
            WHERE type(dup) = type(r)
          }
        DELETE r
      `, { mergeId, keepId });
      await tx.run(`
        MATCH (a:Task|Skill|Event)-[r]->(merge:Task|Skill|Event {id: $mergeId})
        WHERE a.id <> $keepId
          AND NOT EXISTS {
            MATCH (keep:Task|Skill|Event {id: $keepId}), (a)-[dup]->(keep)
            WHERE type(dup) = type(r)
          }
        WITH a, r, type(r) AS rType, properties(r) AS props
        MATCH (keep:Task|Skill|Event {id: $keepId})
        CALL apoc.create.relationship(a, rType, props, keep) YIELD rel
        DELETE r
      `, { mergeId, keepId });

      // 迁移出边：从 mergeId 出发的边改从 keepId 出发（同上去重）
      await tx.run(`
        MATCH (merge:Task|Skill|Event {id: $mergeId})-[r]->(b:Task|Skill|Event)
        WHERE b.id <> $keepId
          AND EXISTS {
            MATCH (keep:Task|Skill|Event {id: $keepId}), (keep)-[dup]->(b)
            WHERE type(dup) = type(r)
          }
        DELETE r
      `, { mergeId, keepId });
      await tx.run(`
        MATCH (merge:Task|Skill|Event {id: $mergeId})-[r]->(b:Task|Skill|Event)
        WHERE b.id <> $keepId
          AND NOT EXISTS {
            MATCH (keep:Task|Skill|Event {id: $keepId}), (keep)-[dup]->(b)
            WHERE type(dup) = type(r)
          }
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

      // 标记 deprecated（deprecatedBy='merge'：不参与 decay 复活；参与 purge 到期硬删）
      await tx.run(
        `MATCH (n:Task|Skill|Event {id: $mergeId})
         SET n.status = 'deprecated',
             n.deprecatedAt = $now,
             n.deprecatedBy = 'merge',
             n.updatedAt = $now`,
        { mergeId, now: Date.now() },
      );
    });
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

export async function clearCommunities(driver: Driver): Promise<void> {
  const session = getSession(driver);
  try {
    await session.run(`
      MATCH (n:MemoryNode)
      SET n.communityId = null
      WITH count(n) AS nodeCount
      MATCH (c:Community)
      DETACH DELETE c
      RETURN nodeCount, count(c) AS deletedCommunities
    `);
  } finally {
    await session.close();
  }
}

// ─── 边 CRUD ─────────────────────────────────────────────────

export async function upsertEdge(
  driver: Driver,
  e: { fromId: string; toId: string; type: EdgeType; instruction: string; condition?: string; sessionId: string },
): Promise<boolean> {
  const session = getSession(driver);
  try {
    // TypeScript 类型不能保护 LLM/HTTP 运行时输入；按数据库中的真实端点类型复核。
    const endpoints = await session.run(`
      MATCH (a:Task|Skill|Event {id: $fromId}), (b:Task|Skill|Event {id: $toId})
      RETURN a.type AS fromType, b.type AS toType
    `, { fromId: e.fromId, toId: e.toId });
    if (endpoints.records.length === 0) return false;
    const fromType = endpoints.records[0].get("fromType");
    const toType = endpoints.records[0].get("toType");
    if (!isValidEdgeDirection(e.type, fromType, toType)) return false;

    // MERGE 语义：查重 + 创建/更新合并为单条原子语句，消除并发下绕过查重产生重复边的窗口。
    // onCreate 写入全部属性；onMatch 仅刷新 instruction（与原查重-更新分支行为一致）。
    await session.run(`
      MATCH (a:Task|Skill|Event {id: $fromId}), (b:Task|Skill|Event {id: $toId})
      CALL apoc.merge.relationship(a, $type, {}, {
        id: $id, instruction: $instruction, condition: $condition,
        sessionId: $sessionId, createdAt: $now
      }, b, { instruction: $instruction }) YIELD rel
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
    return true;
  } finally {
    await session.close();
  }
}

export async function edgesFrom(driver: Driver, id: string): Promise<GmEdge[]> {
  const session = getSession(driver);
  try {
    const result = await session.run(`
      MATCH (a:Task|Skill|Event {id: $id})-[r]->(b:Task|Skill|Event)
      WHERE ${EDGE_TYPE_FILTER}${EDGE_ROW_RETURN}
    `, { id });
    return mapEdgeRecords(result);
  } finally {
    await session.close();
  }
}

export async function edgesTo(driver: Driver, id: string): Promise<GmEdge[]> {
  const session = getSession(driver);
  try {
    const result = await session.run(`
      MATCH (a:Task|Skill|Event)-[r]->(b:Task|Skill|Event {id: $id})
      WHERE ${EDGE_TYPE_FILTER}${EDGE_ROW_RETURN}
    `, { id });
    return mapEdgeRecords(result);
  } finally {
    await session.close();
  }
}

/** 批量查询至少一端在 ids 内的知识边 —— 一次往返替代逐节点 edgesFrom+edgesTo 的 2N 次往返。 */
export async function edgesTouching(driver: Driver, ids: string[]): Promise<GmEdge[]> {
  if (!ids.length) return [];
  const session = getSession(driver);
  try {
    const result = await session.run(`
      MATCH (a:Task|Skill|Event)-[r]->(b:Task|Skill|Event)
      WHERE (a.id IN $ids OR b.id IN $ids)
        AND ${EDGE_TYPE_FILTER}${EDGE_ROW_RETURN}
    `, { ids });
    return mapEdgeRecords(result);
  } finally {
    await session.close();
  }
}

/** 删除 from→to 之间的边；type 省略时删除所有类型。返回删除条数。 */
export async function deleteEdges(
  driver: Driver,
  fromId: string,
  toId: string,
  type?: EdgeType,
): Promise<number> {
  const session = getSession(driver);
  try {
    const result = type
      ? await session.run(
          `MATCH (a:Task|Skill|Event {id: $fromId})-[r]->(b:Task|Skill|Event {id: $toId})
           WHERE type(r) = $type
           DELETE r
           RETURN count(r) AS deleted`,
          { fromId, toId, type },
        )
      : await session.run(
          `MATCH (a:Task|Skill|Event {id: $fromId})-[r]->(b:Task|Skill|Event {id: $toId})
           DELETE r
           RETURN count(r) AS deleted`,
          { fromId, toId },
        );
    return toInt(result.records[0]?.get("deleted") ?? 0);
  } finally {
    await session.close();
  }
}

/** 按 edge id 删除单条边（REST DELETE /edges?id= 用）。返回删除条数（0/1）。 */
export async function deleteEdgeById(driver: Driver, edgeId: string): Promise<number> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      `MATCH ()-[r]->()
       WHERE r.id = $edgeId
       DELETE r
       RETURN count(r) AS deleted`,
      { edgeId },
    );
    return toInt(result.records[0]?.get("deleted") ?? 0);
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

type ScoredNode = { node: GmNode; score: number };

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

/** 社区向量搜索 */
type ScoredCommunity = { id: string; summary: string; score: number; nodeCount: number };

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

/**
 * 单发写向量 + contentHash。hash 可选：调用方已为短路检查预计算过 md5 时
 * 直接传入，避免对同一 content 重复哈希（缺省时内部补算）。
 */
export async function saveVector(
  driver: Driver, nodeId: string, content: string, vec: number[], hash?: string,
): Promise<void> {
  const contentHash = hash ?? createHash("md5").update(content).digest("hex");
  const session = getSession(driver);
  try {
    await session.run(`
      MATCH (n:Task|Skill|Event {id: $nodeId})
      SET n.embedding = $vec, n.contentHash = $contentHash
    `, { nodeId, vec, contentHash });
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

/**
 * 批量读取 contentHash（syncEmbedBatch 用）：一次往返替代逐节点 getVectorHash 的 N 次。
 * 返回 Map<nodeId, hash|null>；不存在的节点映射为 null（视为需要嵌入）。
 */
export async function getVectorHashes(driver: Driver, nodeIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (!nodeIds.length) return out;
  const session = getSession(driver);
  try {
    const result = await session.run(
      `UNWIND $ids AS id
       MATCH (n:Task|Skill|Event {id: id})
       RETURN n.id AS id, n.contentHash AS hash`,
      { ids: nodeIds },
    );
    for (const r of result.records) out.set(r.get("id"), r.get("hash") ?? null);
  } finally {
    await session.close();
  }
  for (const id of nodeIds) if (!out.has(id)) out.set(id, null);
  return out;
}

export interface BatchVectorEntry {
  nodeId: string;
  content: string;
  vec: number[];
  hash: string;
}

/** 批量写向量 + contentHash（syncEmbedBatch 用）：一次 UNWIND 写入替代 N 次 saveVector。 */
export async function saveVectors(driver: Driver, entries: BatchVectorEntry[]): Promise<void> {
  if (!entries.length) return;
  const session = getSession(driver);
  try {
    await session.run(
      `UNWIND $entries AS e
       MATCH (n:Task|Skill|Event {id: e.nodeId})
       SET n.embedding = e.vec, n.contentHash = e.hash`,
      { entries: entries.map(e => ({ nodeId: e.nodeId, vec: e.vec, hash: e.hash })) },
    );
  } finally {
    await session.close();
  }
}

// ─── 重嵌入（换 embedding 模型后的批量重建，graph-memory reembed） ───

export interface EmbeddingStats {
  nodesTotal: number;
  nodesEmbedded: number;
  communitiesTotal: number;
  communitiesEmbedded: number;
}

/** 向量覆盖情况统计（reembed 报告 + dry-run 用） */
export async function getEmbeddingStats(driver: Driver): Promise<EmbeddingStats> {
  const session = getSession(driver);
  try {
    const nodeRes = await session.run(`
      MATCH (n:MemoryNode {status: 'active'})
      RETURN count(n) AS total, count(n.embedding) AS embedded
    `);
    const commRes = await session.run(`
      MATCH (c:Community)
      RETURN count(c) AS total, count(c.embedding) AS embedded
    `);
    const nodeRec = nodeRes.records[0];
    const commRec = commRes.records[0];
    return {
      nodesTotal: nodeRec ? toInt(nodeRec.get("total")) : 0,
      nodesEmbedded: nodeRec ? toInt(nodeRec.get("embedded")) : 0,
      communitiesTotal: commRec ? toInt(commRec.get("total")) : 0,
      communitiesEmbedded: commRec ? toInt(commRec.get("embedded")) : 0,
    };
  } finally {
    await session.close();
  }
}

/**
 * 清空（void）全部向量。contentHash 必须与 embedding 一同清除：
 * syncEmbed 以"文本 hash 未变"短路，只清 embedding 会让重嵌入被旧 hash 跳过。
 */
export async function clearAllEmbeddings(
  driver: Driver,
): Promise<{ nodes: number; communities: number }> {
  const session = getSession(driver);
  try {
    const nodeRes = await session.run(`
      MATCH (n:MemoryNode)
      WHERE n.embedding IS NOT NULL OR n.contentHash IS NOT NULL
      REMOVE n.embedding, n.contentHash
      RETURN count(n) AS cleared
    `);
    const commRes = await session.run(`
      MATCH (c:Community)
      WHERE c.embedding IS NOT NULL
      REMOVE c.embedding
      RETURN count(c) AS cleared
    `);
    return {
      nodes: nodeRes.records[0] ? toInt(nodeRes.records[0].get("cleared")) : 0,
      communities: commRes.records[0] ? toInt(commRes.records[0].get("cleared")) : 0,
    };
  } finally {
    await session.close();
  }
}

/** 待重嵌入节点（游标分页 —— 重建过程会让集合收缩，SKIP 分页会跳号） */
export interface NodeEmbeddingTarget {
  id: string;
  name: string;
  description: string;
  content: string;
}

export async function listNodeEmbeddingTargets(
  driver: Driver,
  afterId: string,
  limit: number,
): Promise<NodeEmbeddingTarget[]> {
  const session = getSession(driver);
  try {
    const result = await session.run(`
      MATCH (n:MemoryNode {status: 'active'})
      WHERE n.embedding IS NULL AND n.id > $afterId
      RETURN n.id AS id, n.name AS name, n.description AS description, n.content AS content
      ORDER BY n.id
      LIMIT toInteger($limit)
    `, { afterId, limit: nint(limit) });
    return result.records.map(r => ({
      id: r.get("id") ?? "",
      name: r.get("name") ?? "",
      description: r.get("description") ?? "",
      content: r.get("content") ?? "",
    }));
  } finally {
    await session.close();
  }
}

/** 待重嵌入社区（摘要非空才可嵌入） */
export interface CommunityEmbeddingTarget {
  id: string;
  summary: string;
}

export async function listCommunityEmbeddingTargets(
  driver: Driver,
  afterId: string,
  limit: number,
): Promise<CommunityEmbeddingTarget[]> {
  const session = getSession(driver);
  try {
    const result = await session.run(`
      MATCH (c:Community)
      WHERE c.embedding IS NULL AND c.summary IS NOT NULL AND trim(c.summary) <> ''
      RETURN c.id AS id, c.summary AS summary
      ORDER BY c.id
      LIMIT toInteger($limit)
    `, { afterId, limit: nint(limit) });
    return result.records.map(r => ({
      id: r.get("id") ?? "",
      summary: r.get("summary") ?? "",
    }));
  } finally {
    await session.close();
  }
}

export async function saveCommunityEmbedding(driver: Driver, id: string, vec: number[]): Promise<void> {
  const session = getSession(driver);
  try {
    await session.run(
      "MATCH (c:Community {id: $id}) SET c.embedding = $vec",
      { id, vec },
    );
  } finally {
    await session.close();
  }
}

/** 读取两个向量索引的维度（索引不存在时为 null —— 全新库场景） */
export async function getVectorIndexDimensions(driver: Driver): Promise<Record<string, number | null>> {
  const session = getSession(driver);
  try {
    const result = await session.run(`
      SHOW INDEXES YIELD name, options
      WHERE name IN ['gm_node_embedding', 'gm_community_embedding']
      RETURN name, options.indexConfig AS indexConfig
    `);
    const out: Record<string, number | null> = {
      gm_node_embedding: null,
      gm_community_embedding: null,
    };
    for (const r of result.records) {
      const name = r.get("name");
      const indexConfig = r.get("indexConfig") as any;
      const dim = indexConfig?.["vector.dimensions"];
      if (typeof name === "string" && name in out && typeof dim === "number") {
        out[name] = dim;
      }
    }
    return out;
  } finally {
    await session.close();
  }
}

/** 删除两个向量索引（--recreate-index 重建路径；initSchema 会按配置重新创建） */
export async function dropVectorIndexes(driver: Driver): Promise<void> {
  const session = getSession(driver);
  try {
    await session.run("DROP INDEX gm_node_embedding IF EXISTS");
    await session.run("DROP INDEX gm_community_embedding IF EXISTS");
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

  // maxDepth 来自配置且直接内插进 Cypher —— clamp 到 [1,4]，非法值只会得到安全深度而非语法错误
  const parsedDepth = Number(maxDepth);
  const depth = Math.max(1, Math.min(4, Number.isFinite(parsedDepth) ? Math.floor(parsedDepth) : 2));

  const session = getSession(driver);
  try {
    // 用 Neo4j 的变长路径匹配做图遍历
    const nodeResult = await session.run(`
      MATCH (seed:Task|Skill|Event)
      WHERE seed.id IN $seedIds AND seed.status = 'active'
      CALL {
        WITH seed
        MATCH path = (seed)-[*0..${depth}]-(neighbor:Task|Skill|Event {status: 'active'})
        WHERE all(node IN nodes(path) WHERE node.status = 'active')
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
        AND ${EDGE_TYPE_FILTER}${EDGE_ROW_RETURN}
    `, { nodeIds });

    const edges = mapEdgeRecords(edgeResult);

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

/**
 * 每社区取最近更新的 perCommunity 个代表节点。
 * totalLimit 封顶总返回数（按社区规模降序截断）—— recall 兜底路径用它做
 * graphWalk 种子，社区很多时无上限种子会把遍历放大成全图扫描。
 */
export async function communityRepresentatives(
  driver: Driver,
  perCommunity = 2,
  totalLimit = 20,
): Promise<GmNode[]> {
  const session = getSession(driver);
  try {
    const result = await session.run(`
      MATCH (n:Task|Skill|Event {status: 'active'})
      WHERE n.communityId IS NOT NULL
      WITH n.communityId AS cid, n
      ORDER BY n.updatedAt DESC
      WITH cid, collect(n) AS members
      ORDER BY size(members) DESC
      UNWIND members[0..toInteger($perCommunity)] AS m
      RETURN m AS n
      LIMIT toInteger($totalLimit)
    `, { perCommunity, totalLimit });
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
      ON MATCH SET
        m.role = $role,
        m.content = $content
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

/** 该会话当前最大 turnIndex（无消息返回 0）。用于插件重启后恢复内存 msgSeq；
 *  否则 turnIndex 从 1 重计 → MERGE 命中旧行 → ON CREATE 被跳过 → 新消息被静默丢弃。 */
export async function getMaxTurnIndex(driver: Driver, sid: string): Promise<number> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      `MATCH (m:GmMessage {sessionId: $sid})
       RETURN coalesce(max(m.turnIndex), 0) AS maxTurn`,
      { sid },
    );
    return toInt(result.records[0].get("maxTurn"));
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
        turn_index: toInt(m.turnIndex),
      };
    });
  } finally {
    await session.close();
  }
}

/** 未提取消息计数（batched 提取模式的攒批触发判定）。 */
export async function countUnextracted(driver: Driver, sid: string): Promise<number> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      "MATCH (m:GmMessage {sessionId: $sid, extracted: false}) RETURN count(m) AS c",
      { sid },
    );
    return toInt(result.records[0].get("c"));
  } finally {
    await session.close();
  }
}

export interface UnextractedSessionInfo {
  sessionId: string;
  messageCount: number;
  maxTurn: number;
  minCreatedAt: number;
}

export async function listUnextractedSessions(driver: Driver): Promise<UnextractedSessionInfo[]> {
  const session = getSession(driver);
  try {
    const result = await session.run(`
      MATCH (m:GmMessage {extracted: false})
      WITH m.sessionId AS sid,
           count(*) AS msgCount,
           max(m.turnIndex) AS maxTurn,
           min(coalesce(m.createdAt, 0)) AS minCreated
      WHERE sid IS NOT NULL
      RETURN sid, msgCount, maxTurn, minCreated
      ORDER BY minCreated ASC, sid ASC
    `);
    return result.records.map(r => ({
      sessionId: r.get("sid"),
      messageCount: toInt(r.get("msgCount")),
      maxTurn: toInt(r.get("maxTurn")),
      minCreatedAt: toInt(r.get("minCreated")),
    }));
  } finally {
    await session.close();
  }
}

/**
 * 标记 sid 会话内 turnIndex ≤ upToTurn 的消息为已提取。
 *
 * producedKnowledge：该次提取是否实际产出节点/边。LLM 成功返回零节点零边时
 * 传 false —— 原始证据保留（retention 只删 producedKnowledge=true 的行）。
 * 注意空提取轮次不会自动重提：重挖需手动将其 extracted 重置为 false 再跑
 * `openclaw graph-memory extract`。
 *
 * 只作用于尚未提取的行（extracted=false）：producedKnowledge 在提取转换时刻
 * 一次性写入，不会被后续更大范围的批量标记覆盖（compact 的范围标记可能横跨
 * 早期已标记的轮次）。遗留行（无 producedKnowledge 属性）保持 null，
 * retention 对其 fail-closed 不删。
 */
export async function markExtracted(
  driver: Driver, sid: string, upToTurn: number, producedKnowledge = true,
): Promise<void> {
  const session = getSession(driver);
  try {
    await session.run(`
      MATCH (m:GmMessage {sessionId: $sid})
      WHERE m.turnIndex <= $upToTurn AND m.extracted = false
      SET m.extracted = true, m.producedKnowledge = $pk
    `, { sid, upToTurn, pk: producedKnowledge });
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

// ─── 轮次提交标记（OpenClaw transcript fencing 契约） ─────────

/** neo4j-driver 约束冲突错误的 code 形如 Neo.ClientError.Schema.ConstraintValidationFailed */
function isConstraintViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" && code.includes("ConstraintValidation")) return true;
  return String(err).includes("ConstraintValidation");
}

/**
 * 幂等提交一个 logical turn（host 只对成功接受的轮次调用，重试携带同一 advancementKey）。
 * 唯一约束 + CREATE 保证原子幂等：首次 → "committed"；重试撞约束 → "duplicate"。
 * 标记节点本身即"一次原子幂等写"的全部载荷 —— 消息已由 ingest/afterTurn 逐条落库，
 * 不在标记里重复存（否则与 GmMessage 行双写、outage 缓冲路径无法对齐）。
 */
export async function commitTurnAdvance(
  driver: Driver, sid: string, advancementKey: string, messageCount: number,
): Promise<"committed" | "duplicate"> {
  const session = getSession(driver);
  try {
    await session.run(
      `CREATE (t:GmTurnCommit {advancementKey: $key, sessionId: $sid, messageCount: $count, createdAt: $now})`,
      { key: advancementKey, sid, count: messageCount, now: Date.now() },
    );
    return "committed";
  } catch (err) {
    if (isConstraintViolation(err)) return "duplicate";
    throw err;
  } finally {
    await session.close();
  }
}

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
      WHERE ${EDGE_TYPE_FILTER}
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
  /** 成员 ID 排序后的 sha1 — 用于识别"成员构成未变"的社区（复用摘要） */
  memberSignature: string | null;
  createdAt: number;
  updatedAt: number;
}

export async function upsertCommunitySummary(
  driver: Driver, id: string, summary: string, nodeCount: number,
  embedding?: number[], memberSignature?: string,
): Promise<void> {
  const session = getSession(driver);
  try {
    await session.run(`
      MERGE (c:Community {id: $id})
      ON CREATE SET
        c.summary = $summary,
        c.nodeCount = $nodeCount,
        c.embedding = $embedding,
        c.memberSignature = $memberSignature,
        c.createdAt = $now,
        c.updatedAt = $now
      ON MATCH SET
        c.summary = $summary,
        c.nodeCount = $nodeCount,
        c.embedding = CASE WHEN $embedding IS NOT NULL THEN $embedding ELSE c.embedding END,
        c.memberSignature = CASE WHEN $memberSignature IS NOT NULL THEN $memberSignature ELSE c.memberSignature END,
        c.updatedAt = $now
    `, {
      id,
      summary,
      nodeCount,
      embedding: embedding ?? null,
      memberSignature: memberSignature ?? null,
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
      memberSignature: c.memberSignature ?? null,
      createdAt: toInt(c.createdAt),
      updatedAt: toInt(c.updatedAt),
    };
  } finally {
    await session.close();
  }
}

export async function getCommunitySummaryBySignature(
  driver: Driver, memberSignature: string,
): Promise<(CommunitySummary & { embedding?: number[] }) | null> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      "MATCH (c:Community {memberSignature: $memberSignature}) RETURN c ORDER BY c.updatedAt DESC LIMIT 1",
      { memberSignature },
    );
    if (result.records.length === 0) return null;
    const c = result.records[0].get("c").properties;
    return {
      id: c.id,
      summary: c.summary,
      nodeCount: toInt(c.nodeCount),
      memberSignature: c.memberSignature ?? null,
      embedding: Array.isArray(c.embedding) ? (c.embedding as number[]) : undefined,
      createdAt: toInt(c.createdAt),
      updatedAt: toInt(c.updatedAt),
    };
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
