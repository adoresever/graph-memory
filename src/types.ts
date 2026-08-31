/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

/**
 * graph-memory 类型定义
 *
 * 节点：TASK / SKILL / EVENT
 * 边：USED_SKILL / SOLVED_BY / REQUIRES / PATCHES / CONFLICTS_WITH
 */

// ─── 节点 ─────────────────────────────────────────────────────

export type NodeType = "TASK" | "SKILL" | "EVENT";
export type NodeStatus = "active" | "deprecated";

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

// ─── 信号 ─────────────────────────────────────────────────────

export type SignalType =
  | "tool_error"
  | "tool_success"
  | "skill_invoked"
  | "user_correction"
  | "explicit_record"
  | "task_completed";

export interface Signal {
  type: SignalType;
  turnIndex: number;
  data: Record<string, any>;
}

// ─── 提取结果 ─────────────────────────────────────────────────

export interface ExtractionResult {
  nodes: Array<{
    type: NodeType;
    name: string;
    description: string;
    content: string;
    /** Source message turn/event indices cited by the extractor. */
    sourceTurns?: number[];
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
  /** Runtime-only credential resolver. Host adapters use this to avoid putting secrets in config. */
  apiKeyResolver?: () => Promise<string | undefined>;
  baseURL?: string;
  /** Alias used by OpenClaw and several OpenAI-compatible providers. */
  baseUrl?: string;
  model?: string;
  dimensions?: number;
}

// ─── 插件配置 ─────────────────────────────────────────────────

export interface GmConfig {
  dbPath: string;
  compactTurnCount: number;
  recallMaxNodes: number;
  recallMaxDepth: number;
  freshTailCount: number;
  embedding?: EmbeddingConfig;
  llm?: {
    apiKey?: string;
    baseURL?: string;
    /** Alias used by OpenClaw and several OpenAI-compatible providers. */
    baseUrl?: string;
    model?: string;
  };
  /** 向量去重阈值，余弦相似度超过此值视为重复 (0-1) */
  dedupThreshold: number;
  /** PageRank 阻尼系数 */
  pagerankDamping: number;
  /** PageRank 迭代次数 */
  pagerankIterations: number;
  /** 向量召回种子选择：与最高分允许的差距（低于最高分此值即视为不相关，0-1） */
  recallScoreGap?: number;
  /** 向量召回种子选择：最低接受分数（默认 0.58，bge-m3 短文本实测区分带） */
  recallMinScore?: number;
  /** 向量召回种子选择：种子数硬上限（默认 recallMaxNodes*2） */
  recallSeedCap?: number;
}

export const DEFAULT_CONFIG: GmConfig = {
  dbPath: "~/.openclaw/graph-memory.db",
  compactTurnCount: 6,
  recallMaxNodes: 6,
  recallMaxDepth: 2,
  freshTailCount: 10,
  dedupThreshold: 0.90,
  pagerankDamping: 0.85,
  pagerankIterations: 20,
  recallScoreGap: 0.10,
  recallMinScore: 0.58,
};
