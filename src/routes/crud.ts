/**
 * graph-memory-pro — CRUD HTTP Routes
 *
 * 注册一个 prefix route /graph-memory-pro/api/ 处理所有增删改查请求。
 * 每个写节点操作后 fire-and-forget syncEmbed 更新向量。
 *
 * 文件位置: graph-memory-pro/src/routes/crud.ts
 *
 * 在 index.ts register() 中调用：
 *   import { registerCrudRoutes } from "./src/routes/crud.ts";
 *   registerCrudRoutes(api, driver, recaller);
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Driver } from "neo4j-driver";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { Recaller } from "../recaller/recall.ts";
import type { NodeType, EdgeType } from "../types.ts";
import {
  upsertNode, findById, findByName, allActiveNodes, allEdges,
  upsertEdge, edgesFrom, edgesTo, deprecate, mergeNodes,
  searchNodes, getStats,
} from "../store/store.ts";
import { getSession } from "../store/db.ts";

// ── Helpers ──────────────────────────────────────────────────

/** Read JSON body from IncomingMessage */
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/** Send JSON response */
function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/** Parse query string from URL */
function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf("?");
  if (idx < 0) return {};
  const params: Record<string, string> = {};
  const qs = url.slice(idx + 1);
  for (const pair of qs.split("&")) {
    const [k, v] = pair.split("=");
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
  }
  return params;
}

/** Extract sub-path after /graph-memory-pro/api/ */
function getSubPath(url: string): string {
  const base = "/graph-memory-pro/api/";
  const idx = url.indexOf(base);
  if (idx < 0) return "";
  const rest = url.slice(idx + base.length);
  const qIdx = rest.indexOf("?");
  return qIdx >= 0 ? rest.slice(0, qIdx) : rest;
}

// ── Route Registration ───────────────────────────────────────

export function registerCrudRoutes(
  api: OpenClawPluginApi,
  driver: Driver,
  recaller: Recaller,
): void {
  api.registerHttpRoute({
    path: "/graph-memory-pro/api/",
    auth: "gateway",
    match: "prefix",
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const method = (req.method ?? "GET").toUpperCase();
      const url = req.url ?? "";
      const subPath = getSubPath(url);
      const query = parseQuery(url);

      try {
        // ── /nodes ──────────────────────────────────────────
        if (subPath === "nodes" || subPath === "nodes/") {
          if (method === "GET") {
            return await handleListNodes(res, driver, query);
          }
          if (method === "POST") {
            const body = await readBody(req);
            return await handleCreateNode(res, driver, recaller, body);
          }
          if (method === "PUT") {
            const body = await readBody(req);
            return await handleUpdateNode(res, driver, recaller, query, body);
          }
          if (method === "DELETE") {
            return await handleDeleteNode(res, driver, query);
          }
        }

        // ── /nodes/merge ────────────────────────────────────
        if (subPath === "nodes/merge") {
          if (method === "POST") {
            const body = await readBody(req);
            return await handleMergeNodes(res, driver, recaller, body);
          }
        }

        // ── /edges ──────────────────────────────────────────
        if (subPath === "edges" || subPath === "edges/") {
          if (method === "GET") {
            return await handleListEdges(res, driver, query);
          }
          if (method === "POST") {
            const body = await readBody(req);
            return await handleCreateEdge(res, driver, body);
          }
          if (method === "DELETE") {
            return await handleDeleteEdge(res, driver, query);
          }
        }

        // ── /stats ──────────────────────────────────────────
        if (subPath === "stats") {
          if (method === "GET") {
            return await handleStats(res, driver);
          }
        }

        // ── 404 ─────────────────────────────────────────────
        json(res, 404, { error: `Unknown route: ${method} /graph-memory-pro/api/${subPath}` });
        return true;
      } catch (err) {
        api.logger.error(`[graph-memory-pro/api] ${method} /${subPath} failed: ${err}`);
        json(res, 500, { error: String(err) });
        return true;
      }
    },
  });

  api.logger.info("[graph-memory-pro] CRUD API routes registered at /graph-memory-pro/api/*");
}

// ── Handlers ─────────────────────────────────────────────────

/**
 * GET /nodes?q=xxx&limit=50&type=TASK
 * 列表 / 搜索节点
 */
async function handleListNodes(
  res: ServerResponse,
  driver: Driver,
  query: Record<string, string>,
): Promise<boolean> {
  const q = query.q ?? query.query ?? "";
  const limit = Math.min(parseInt(query.limit ?? "50", 10) || 50, 200);
  const typeFilter = query.type?.toUpperCase();

  let nodes;
  if (q) {
    nodes = await searchNodes(driver, q, limit);
  } else {
    nodes = await allActiveNodes(driver);
  }

  // Optional type filter
  if (typeFilter && ["TASK", "SKILL", "EVENT"].includes(typeFilter)) {
    nodes = nodes.filter(n => n.type === typeFilter);
  }

  // Sort by pagerank desc, then updatedAt desc
  nodes.sort((a, b) => b.pagerank - a.pagerank || b.updatedAt - a.updatedAt);

  // Apply limit
  if (nodes.length > limit) nodes = nodes.slice(0, limit);

  json(res, 200, { nodes, total: nodes.length });
  return true;
}

/**
 * POST /nodes
 * Body: { type: "TASK"|"SKILL"|"EVENT", name: string, description: string, content: string }
 */
async function handleCreateNode(
  res: ServerResponse,
  driver: Driver,
  recaller: Recaller,
  body: Record<string, unknown>,
): Promise<boolean> {
  const type = (body.type as string ?? "TASK").toUpperCase() as NodeType;
  const name = body.name as string;
  const description = body.description as string ?? "";
  const content = body.content as string ?? "";

  if (!name?.trim()) {
    json(res, 400, { error: "name is required" });
    return true;
  }

  if (!["TASK", "SKILL", "EVENT"].includes(type)) {
    json(res, 400, { error: `Invalid type: ${type}. Must be TASK, SKILL, or EVENT` });
    return true;
  }

  const { node, isNew } = await upsertNode(driver, {
    type, name: name.trim(), description, content,
  }, "clawx-manual");

  // Fire-and-forget: 异步更新向量
  recaller.syncEmbed(node).catch(() => {});

  json(res, isNew ? 201 : 200, { node, isNew });
  return true;
}

/**
 * PUT /nodes?id=xxx
 * Body: { name?, description?, content?, type? }
 * 部分更新节点属性
 */
async function handleUpdateNode(
  res: ServerResponse,
  driver: Driver,
  recaller: Recaller,
  query: Record<string, string>,
  body: Record<string, unknown>,
): Promise<boolean> {
  const id = query.id ?? body.id as string;
  if (!id) {
    json(res, 400, { error: "id is required (query param or body)" });
    return true;
  }

  const existing = await findById(driver, id);
  if (!existing) {
    json(res, 404, { error: `Node not found: ${id}` });
    return true;
  }

  // Build SET clause from provided fields
  const updates: string[] = [];
  const params: Record<string, unknown> = { id, now: Date.now() };

  if (body.description !== undefined) {
    updates.push("n.description = $description");
    params.description = body.description as string;
  }
  if (body.content !== undefined) {
    updates.push("n.content = $content");
    params.content = body.content as string;
  }
  if (body.name !== undefined) {
    // Name change — normalize
    const newName = (body.name as string).trim().toLowerCase()
      .replace(/[\s_]+/g, "-")
      .replace(/[^a-z0-9\u4e00-\u9fff\-]/g, "")
      .replace(/-{2,}/g, "-")
      .replace(/^-|-$/g, "");
    updates.push("n.name = $newName");
    params.newName = newName;
  }
  if (body.type !== undefined) {
    const newType = (body.type as string).toUpperCase();
    if (["TASK", "SKILL", "EVENT"].includes(newType)) {
      updates.push("n.type = $newType");
      params.newType = newType;
    }
  }

  updates.push("n.updatedAt = $now");

  if (updates.length > 1) {  // always has updatedAt
    const session = getSession(driver);
    try {
      await session.run(
        `MATCH (n:Task|Skill|Event {id: $id}) SET ${updates.join(", ")}`,
        params,
      );
    } finally {
      await session.close();
    }
  }

  // Re-fetch updated node
  const updated = await findById(driver, id);
  if (updated) {
    // Fire-and-forget: 异步更新向量（content hash 机制会自动判断是否需要）
    recaller.syncEmbed(updated).catch(() => {});
  }

  json(res, 200, { node: updated });
  return true;
}

/**
 * DELETE /nodes?id=xxx
 * 标记节点为 deprecated（软删除）
 */
async function handleDeleteNode(
  res: ServerResponse,
  driver: Driver,
  query: Record<string, string>,
): Promise<boolean> {
  const id = query.id;
  if (!id) {
    json(res, 400, { error: "id query param is required" });
    return true;
  }

  const existing = await findById(driver, id);
  if (!existing) {
    json(res, 404, { error: `Node not found: ${id}` });
    return true;
  }

  await deprecate(driver, id);

  // 向量不需要删除 — deprecated 节点的向量搜索时会被 status='active' 过滤掉

  json(res, 200, { success: true, id, name: existing.name });
  return true;
}

/**
 * POST /nodes/merge
 * Body: { keepId: string, mergeId: string }
 */
async function handleMergeNodes(
  res: ServerResponse,
  driver: Driver,
  recaller: Recaller,
  body: Record<string, unknown>,
): Promise<boolean> {
  const keepId = body.keepId as string ?? body.targetId as string;
  const mergeId = body.mergeId as string ?? body.sourceId as string;

  if (!keepId || !mergeId) {
    json(res, 400, { error: "keepId and mergeId are required" });
    return true;
  }

  if (keepId === mergeId) {
    json(res, 400, { error: "keepId and mergeId must be different" });
    return true;
  }

  const keepNode = await findById(driver, keepId);
  const mergeNode = await findById(driver, mergeId);

  if (!keepNode) {
    json(res, 404, { error: `Keep node not found: ${keepId}` });
    return true;
  }
  if (!mergeNode) {
    json(res, 404, { error: `Merge node not found: ${mergeId}` });
    return true;
  }

  await mergeNodes(driver, keepId, mergeId);

  // Re-fetch the kept node (content may have changed from merge)
  const updated = await findById(driver, keepId);
  if (updated) {
    recaller.syncEmbed(updated).catch(() => {});
  }

  json(res, 200, {
    success: true,
    kept: updated,
    merged: { id: mergeId, name: mergeNode.name, status: "deprecated" },
  });
  return true;
}

/**
 * GET /edges?nodeId=xxx  (edges from/to a node)
 * GET /edges             (all edges)
 */
async function handleListEdges(
  res: ServerResponse,
  driver: Driver,
  query: Record<string, string>,
): Promise<boolean> {
  const nodeId = query.nodeId ?? query.node_id;

  if (nodeId) {
    const [from, to] = await Promise.all([
      edgesFrom(driver, nodeId),
      edgesTo(driver, nodeId),
    ]);
    // Deduplicate
    const edgeMap = new Map<string, typeof from[0]>();
    for (const e of [...from, ...to]) edgeMap.set(e.id, e);
    const edges = Array.from(edgeMap.values());
    json(res, 200, { edges, total: edges.length });
  } else {
    const edges = await allEdges(driver);
    json(res, 200, { edges, total: edges.length });
  }
  return true;
}

/**
 * POST /edges
 * Body: { fromId, toId, type, instruction, condition? }
 */
async function handleCreateEdge(
  res: ServerResponse,
  driver: Driver,
  body: Record<string, unknown>,
): Promise<boolean> {
  const fromId = body.fromId as string ?? body.from_id as string;
  const toId = body.toId as string ?? body.to_id as string;
  const type = (body.type as string ?? "USED_SKILL").toUpperCase() as EdgeType;
  const instruction = body.instruction as string ?? "";
  const condition = body.condition as string | undefined;

  if (!fromId || !toId) {
    json(res, 400, { error: "fromId and toId are required" });
    return true;
  }

  const validTypes = ["USED_SKILL", "SOLVED_BY", "REQUIRES", "PATCHES", "CONFLICTS_WITH"];
  if (!validTypes.includes(type)) {
    json(res, 400, { error: `Invalid edge type: ${type}. Must be one of: ${validTypes.join(", ")}` });
    return true;
  }

  // Verify both nodes exist
  const [fromNode, toNode] = await Promise.all([
    findById(driver, fromId),
    findById(driver, toId),
  ]);
  if (!fromNode) {
    json(res, 404, { error: `Source node not found: ${fromId}` });
    return true;
  }
  if (!toNode) {
    json(res, 404, { error: `Target node not found: ${toId}` });
    return true;
  }

  await upsertEdge(driver, {
    fromId, toId, type, instruction,
    condition,
    sessionId: "clawx-manual",
  });

  json(res, 201, { success: true, fromId, toId, type });
  return true;
}

/**
 * DELETE /edges?id=xxx
 * 或 DELETE /edges?fromId=xxx&toId=yyy&type=USED_SKILL
 */
async function handleDeleteEdge(
  res: ServerResponse,
  driver: Driver,
  query: Record<string, string>,
): Promise<boolean> {
  const edgeId = query.id;
  const fromId = query.fromId ?? query.from_id;
  const toId = query.toId ?? query.to_id;
  const edgeType = query.type;

  const session = getSession(driver);
  try {
    if (edgeId) {
      // Delete by edge id
      await session.run(`
        MATCH ()-[r]->()
        WHERE r.id = $edgeId
        DELETE r
      `, { edgeId });
    } else if (fromId && toId) {
      // Delete by endpoints (+ optional type filter)
      if (edgeType) {
        await session.run(`
          MATCH (a:Task|Skill|Event {id: $fromId})-[r]->(b:Task|Skill|Event {id: $toId})
          WHERE type(r) = $edgeType
          DELETE r
        `, { fromId, toId, edgeType: edgeType.toUpperCase() });
      } else {
        await session.run(`
          MATCH (a:Task|Skill|Event {id: $fromId})-[r]->(b:Task|Skill|Event {id: $toId})
          DELETE r
        `, { fromId, toId });
      }
    } else {
      json(res, 400, { error: "Provide either id or fromId+toId" });
      return true;
    }
  } finally {
    await session.close();
  }

  json(res, 200, { success: true });
  return true;
}

/**
 * GET /stats
 */
async function handleStats(
  res: ServerResponse,
  driver: Driver,
): Promise<boolean> {
  const stats = await getStats(driver);
  json(res, 200, stats);
  return true;
}
