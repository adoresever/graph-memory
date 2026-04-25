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
    model?: string;
    maxTokens?: number;
    /** Enable OpenAI-compatible JSON mode for extraction/finalize calls. */
    jsonMode?: boolean;
  };
  /** Monthly LLM call budget across all graph-memory LLM tasks. 0 means unlimited. */
  llmMonthlyCallBudget: number;
  /** Monthly cap for community summary LLM calls. 0 means unlimited within the global budget. */
  llmMonthlyCommunitySummaryBudget: number;
  /** Monthly cap for session finalize LLM calls. 0 means unlimited within the global budget. */
  llmMonthlyFinalizeBudget: number;
  /** Time zone used to roll monthly/daily LLM counters. */
  llmBudgetTimeZone: string;
  /** Minimum pending messages before a normal extraction batch runs. */
  extractBatchMinMessages: number;
  /** Minimum pending text characters before a normal extraction batch runs. */
  extractBatchMinChars: number;
  /** Short low-signal user/assistant messages at or below this length are skipped. */
  extractTrivialMaxChars: number;
  /** Max characters retained from each message in extraction prompts. */
  extractMaxMessageChars: number;
  /** Max unextracted messages sent to one extraction call. */
  extractMaxBatchMessages: number;
  /** Quiet period before normal pending messages are flushed. 0 disables debounce. */
  extractDebounceMs: number;
  /** Periodic fallback flush for pending messages. 0 disables interval flush. */
  extractFlushIntervalMs: number;
  /** Max existing node names sent to the extractor for de-duplication hints. */
  extractExistingNamesLimit: number;
  /** Output cap for JSON extraction calls. */
  extractOutputMaxTokens: number;
  /** Output cap for session finalize calls. */
  finalizeOutputMaxTokens: number;
  /** Output cap for short community summary calls. */
  communitySummaryMaxTokens: number;
  /** 向量去重阈值，余弦相似度超过此值视为重复 (0-1) */
  dedupThreshold: number;
  /** PageRank 阻尼系数 */
  pagerankDamping: number;
  /** PageRank 迭代次数 */
  pagerankIterations: number;
}

export const DEFAULT_CONFIG: GmConfig = {
  dbPath: "~/.openclaw/graph-memory.db",
  compactTurnCount: 6,
  recallMaxNodes: 6,
  recallMaxDepth: 2,
  freshTailCount: 10,
  llmMonthlyCallBudget: 90_000,
  llmMonthlyCommunitySummaryBudget: 3_000,
  llmMonthlyFinalizeBudget: 3_000,
  llmBudgetTimeZone: "Asia/Shanghai",
  extractBatchMinMessages: 6,
  extractBatchMinChars: 1600,
  extractTrivialMaxChars: 40,
  extractMaxMessageChars: 600,
  extractMaxBatchMessages: 30,
  extractDebounceMs: 45_000,
  extractFlushIntervalMs: 120_000,
  extractExistingNamesLimit: 80,
  extractOutputMaxTokens: 0,
  finalizeOutputMaxTokens: 0,
  communitySummaryMaxTokens: 0,
  dedupThreshold: 0.90,
  pagerankDamping: 0.85,
  pagerankIterations: 20,
};
