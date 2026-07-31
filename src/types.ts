/**
 * graph-memory-pro v2.1 — 类型定义
 *
 * Label 体系：Task / Skill / Event / Community
 * 去掉 Signal 类型，去掉 GmNode 统一 label
 */

// ─── 节点 ─────────────────────────────────────────────────────

export type NodeType = "TASK" | "SKILL" | "EVENT";
export type NodeStatus = "active" | "deprecated";

/** Neo4j label 映射：TASK->Task, SKILL->Skill, EVENT->Event */
export const NODE_TYPE_TO_LABEL: Record<NodeType, string> = {
  TASK: "Task",
  SKILL: "Skill",
  EVENT: "Event",
};

export const ALL_NODE_LABELS = ["Task", "Skill", "Event"];

export interface GmNode {
  id: string;
  type: NodeType;
  name: string;
  description: string;
  content: string;
  status: NodeStatus;
  validatedCount: number;
  sourceSessions: string[];
  communityId: string | null;
  pagerank: number;
  createdAt: number;
  updatedAt: number;
}

// ─── 边 ───────────────────────────────────────────────────────

export type EdgeType =
  | "USED_SKILL"
  | "SOLVED_BY"
  | "REQUIRES"
  | "PATCHES"
  | "CONFLICTS_WITH";

export interface GmEdge {
  id: string;
  fromId: string;
  toId: string;
  type: EdgeType;
  instruction: string;
  condition?: string;
  sessionId: string;
  createdAt: number;
}

// ─── 提取结果 ─────────────────────────────────────────────────

export interface ExtractionResult {
  nodes: Array<{
    type: NodeType;
    name: string;
    description: string;
    content: string;
  }>;
  edges: Array<{
    from: string;
    to: string;
    type: EdgeType;
    instruction: string;
    condition?: string;
  }>;
}

export interface FinalizeResult {
  promotedSkills: Array<{
    type: "SKILL";
    name: string;
    description: string;
    content: string;
  }>;
  newEdges: Array<{
    from: string;
    to: string;
    type: EdgeType;
    instruction: string;
  }>;
  invalidations: string[];
}

// ─── 召回结果 ─────────────────────────────────────────────────

export interface RecallResult {
  nodes: GmNode[];
  edges: GmEdge[];
  tokenEstimate: number;
}

// ─── Embedding 配置 ──────────────────────────────────────────

export interface EmbeddingConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  dimensions?: number;
}

// ─── Neo4j 连接配置 ──────────────────────────────────────────

export interface Neo4jConfig {
  uri: string;
  user: string;
  password: string;
}

// ─── 插件配置 ─────────────────────────────────────────────────

export interface GmConfig {
  neo4j: Neo4jConfig;
  compactTurnCount: number;
  recallMaxNodes: number;
  recallMaxDepth: number;
  freshTailCount: number;
  embedding?: EmbeddingConfig;
  llm?: {
    apiKey?: string;
    baseURL?: string;
    model?: string;
  };
  dedupThreshold: number;
  pagerankDamping: number;
  pagerankIterations: number;
}

export const DEFAULT_CONFIG: GmConfig = {
  neo4j: {
    uri: "bolt://localhost:7687",
    user: "neo4j",
    password: "neo4j",
  },
  compactTurnCount: 6,
  recallMaxNodes: 6,
  recallMaxDepth: 2,
  freshTailCount: 10,
  dedupThreshold: 0.90,
  pagerankDamping: 0.85,
  pagerankIterations: 20,
};
