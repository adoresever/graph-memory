import type { DatabaseSyncInstance } from "../src/store/sqlite.ts";
import { openDb } from "../src/store/db.ts";
import {
  allActiveNodes,
  allEdges,
  findById,
  getStats,
  searchNodes,
} from "../src/store/store.ts";
import type { GmEdge, GmNode, NodeType } from "../src/types.ts";
import type {
  GraphMemoryProHostApi,
  GraphNodeDetail,
  GraphNodeId,
  GraphSnapshot,
  GraphSnapshotEdge,
  GraphSnapshotNode,
  GraphSnapshotRequest,
} from "./types.ts";

export const DEFAULT_SNAPSHOT_NODE_LIMIT = 200;
export const MAX_SNAPSHOT_NODE_LIMIT = 1_000;
export const DEFAULT_SNAPSHOT_EDGE_LIMIT = 2_000;
export const MAX_SNAPSHOT_EDGE_LIMIT = 10_000;
export const DEFAULT_OVERVIEW_TEXT_LIMIT = 1_000;
export const DEFAULT_DETAIL_CONTENT_LIMIT = 20_000;
export const MAX_TEXT_LIMIT = 100_000;

export interface SqliteGraphSnapshotStoreOptions {
  dbPath: string;
  defaultNodeLimit?: number;
  maxNodeLimit?: number;
  maxEdgeLimit?: number;
  overviewTextLimit?: number;
  detailContentLimit?: number;
}

function integerWithin(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}, received ${value}`);
  }
  return value;
}

function bounded(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

function snapshotNode(node: GmNode, textLimit: number): GraphSnapshotNode {
  return {
    id: node.id as GraphNodeId,
    type: node.type,
    name: node.name,
    description: bounded(node.description, textLimit).text,
    status: node.status,
    validatedCount: node.validatedCount,
    sourceSessionCount: node.sourceSessions.length,
    communityId: node.communityId,
    pagerank: node.pagerank,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

function snapshotEdge(edge: GmEdge, textLimit: number): GraphSnapshotEdge {
  return {
    id: edge.id as GraphSnapshotEdge["id"],
    fromId: edge.fromId as GraphNodeId,
    toId: edge.toId as GraphNodeId,
    type: edge.type,
    instruction: bounded(edge.instruction, textLimit).text,
    ...(edge.condition ? { condition: bounded(edge.condition, textLimit).text } : {}),
    createdAt: edge.createdAt,
  };
}

/** SQLite-backed implementation shared with the Community memory engine. */
export class SqliteGraphSnapshotStore implements GraphMemoryProHostApi {
  readonly #db: DatabaseSyncInstance;
  readonly #defaultNodeLimit: number;
  readonly #maxNodeLimit: number;
  readonly #maxEdgeLimit: number;
  readonly #overviewTextLimit: number;
  readonly #detailContentLimit: number;
  #closed = false;

  constructor(options: SqliteGraphSnapshotStoreOptions) {
    this.#maxNodeLimit = integerWithin(
      "maxNodeLimit",
      options.maxNodeLimit ?? MAX_SNAPSHOT_NODE_LIMIT,
      1,
      MAX_SNAPSHOT_NODE_LIMIT,
    );
    this.#defaultNodeLimit = integerWithin(
      "defaultNodeLimit",
      options.defaultNodeLimit ?? Math.min(DEFAULT_SNAPSHOT_NODE_LIMIT, this.#maxNodeLimit),
      1,
      this.#maxNodeLimit,
    );
    this.#maxEdgeLimit = integerWithin(
      "maxEdgeLimit",
      options.maxEdgeLimit ?? DEFAULT_SNAPSHOT_EDGE_LIMIT,
      1,
      MAX_SNAPSHOT_EDGE_LIMIT,
    );
    this.#overviewTextLimit = integerWithin(
      "overviewTextLimit",
      options.overviewTextLimit ?? DEFAULT_OVERVIEW_TEXT_LIMIT,
      1,
      MAX_TEXT_LIMIT,
    );
    this.#detailContentLimit = integerWithin(
      "detailContentLimit",
      options.detailContentLimit ?? DEFAULT_DETAIL_CONTENT_LIMIT,
      1,
      MAX_TEXT_LIMIT,
    );
    this.#db = openDb(options.dbPath);
  }

  getSnapshot(request: GraphSnapshotRequest = {}): GraphSnapshot {
    this.#assertOpen();
    const maxNodes = integerWithin(
      "maxNodes",
      request.maxNodes ?? this.#defaultNodeLimit,
      1,
      this.#maxNodeLimit,
    );
    const allowedTypes = this.#nodeTypes(request.nodeTypes);
    const query = request.query?.trim() ?? "";
    const candidates = query
      ? searchNodes(this.#db, query, this.#maxNodeLimit + 1)
      : allActiveNodes(this.#db)
        .sort((left, right) => right.pagerank - left.pagerank || right.updatedAt - left.updatedAt);
    const filtered = candidates.filter((node) => !allowedTypes || allowedTypes.has(node.type));
    const selected = filtered.slice(0, maxNodes);
    const nodeIds = new Set(selected.map((node) => node.id));
    const matchingEdges = allEdges(this.#db).filter(
      (edge) => nodeIds.has(edge.fromId) && nodeIds.has(edge.toId),
    );
    const stats = getStats(this.#db);

    return {
      generatedAt: Date.now(),
      nodes: selected.map((node) => snapshotNode(node, this.#overviewTextLimit)),
      edges: matchingEdges.slice(0, this.#maxEdgeLimit)
        .map((edge) => snapshotEdge(edge, this.#overviewTextLimit)),
      totals: { nodes: stats.totalNodes, edges: stats.totalEdges },
      truncated: {
        nodes: filtered.length > selected.length,
        edges: matchingEdges.length > this.#maxEdgeLimit,
      },
    };
  }

  getNodeDetail(id: GraphNodeId): GraphNodeDetail | null {
    this.#assertOpen();
    const node = findById(this.#db, String(id));
    if (!node || node.status !== "active") return null;
    const content = bounded(node.content, this.#detailContentLimit);
    return {
      ...snapshotNode(node, this.#overviewTextLimit),
      content: content.text,
      contentTruncated: content.truncated,
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #nodeTypes(types: NodeType[] | undefined): Set<NodeType> | undefined {
    if (!types?.length) return undefined;
    const allowed = new Set<NodeType>();
    for (const type of types) {
      if (type !== "TASK" && type !== "SKILL" && type !== "EVENT") {
        throw new TypeError(`nodeTypes contains unsupported value ${JSON.stringify(type)}`);
      }
      allowed.add(type);
    }
    return allowed;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Graph Memory Pro snapshot store is closed");
  }
}
