import type { EdgeType, NodeStatus, NodeType } from "../src/types.ts";

/** Opaque graph node identifier accepted by the Pro Host API. */
export type GraphNodeId = string & { readonly __graphNodeId: unique symbol };

/** Opaque graph edge identifier emitted by the Pro Host API. */
export type GraphEdgeId = string & { readonly __graphEdgeId: unique symbol };

/** Filters and result limits for a browser-safe graph projection. */
export interface GraphSnapshotRequest {
  query?: string;
  nodeTypes?: NodeType[];
  maxNodes?: number;
}

/** Node fields safe to render in a graph overview. */
export interface GraphSnapshotNode {
  id: GraphNodeId;
  type: NodeType;
  name: string;
  description: string;
  status: NodeStatus;
  validatedCount: number;
  sourceSessionCount: number;
  communityId: string | null;
  pagerank: number;
  createdAt: number;
  updatedAt: number;
}

/** Edge fields safe to render in a graph overview. */
export interface GraphSnapshotEdge {
  id: GraphEdgeId;
  fromId: GraphNodeId;
  toId: GraphNodeId;
  type: EdgeType;
  instruction: string;
  condition?: string;
  createdAt: number;
}

/** Bounded graph data transferred from the DSH Host to a trusted Client plugin. */
export interface GraphSnapshot {
  generatedAt: number;
  nodes: GraphSnapshotNode[];
  edges: GraphSnapshotEdge[];
  totals: {
    nodes: number;
    edges: number;
  };
  truncated: {
    nodes: boolean;
    edges: boolean;
  };
}

/** Full content fetched only after the user selects a known node identifier. */
export interface GraphNodeDetail extends GraphSnapshotNode {
  content: string;
  contentTruncated: boolean;
}

/** Host-owned read API; no database handle, query language, or credential crosses it. */
export interface GraphMemoryProHostApi {
  getSnapshot(request?: GraphSnapshotRequest): GraphSnapshot;
  getNodeDetail(id: GraphNodeId): GraphNodeDetail | null;
}
