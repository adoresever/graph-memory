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
export type TurnOutcome = "completed" | "partial" | "failed" | "informational" | "unknown";

export interface NodeTemporal {
  /** Time stated by the evidence, preserved as written instead of guessed. */
  eventTime?: string;
  /** When the fact or decision starts to apply, if the dialogue says so. */
  validFrom?: string;
  /** When it stops applying, if known. */
  validUntil?: string;
  state?: "current" | "historical" | "uncertain" | "superseded";
}

export interface GmNode {
  id: string;
  type: NodeType;
  name: string;
  description: string;
  content: string;
  temporal: NodeTemporal;
  status: NodeStatus;
  validatedCount: number;
  sourceSessions: string[];
  communityId: string | null;
  pagerank: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Compact episodic index for one completed question/final-answer pair.
 * The exact source messages remain in gm_messages; this record is the first
 * retrieval surface and never replaces its evidence.
 */
export interface GmTurnMemory {
  id: string;
  sessionId: string;
  summary: string;
  outcome: TurnOutcome;
  sources: Array<{ messageId: string; turnIndex: number }>;
  createdAt: number;
  updatedAt: number;
}

/**
 * A lightweight subject-predicate-object index into one turn memory.
 * It is navigation metadata only; the turn summary and exact source Q/A are
 * the evidence returned to the model after retrieval.
 */
export interface GmNavigationTriple {
  id: string;
  memoryId: string;
  sessionId: string;
  subjectId: string;
  subject: string;
  predicate: string;
  objectId: string;
  object: string;
  subjectCommunityId: string | null;
  objectCommunityId: string | null;
  createdAt: number;
}

// ─── 边 ───────────────────────────────────────────────────────

export type EdgeType =
  | "RELATES"
  | "SUPERSEDES"
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
  turn: {
    /** One self-contained sentence describing the request and observed result. */
    summary: string;
    /** Outcome reported by the completed dialogue; not external verification. */
    outcome: TurnOutcome;
  };
  /** Simple navigation derived from turn.summary; never a second fact body. */
  triples: Array<{
    subject: string;
    predicate: string;
    object: string;
  }>;
}

// ─── 召回结果 ─────────────────────────────────────────────────

export interface RecallResult {
  nodes: GmNode[];
  edges: GmEdge[];
  /** Query-matched episodic summaries, ordered by retrieval relevance. */
  turnMemories: GmTurnMemory[];
  /** Navigation triples attached to the matched turn memories. */
  triples: GmNavigationTriple[];
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
  /** Maximum query-matched memory nodes returned by one recall. */
  recallMaxNodes: number;
  /**
   * Provider-calibrated cosine floor for automatic prompt injection.
   * Deliberately required by DEFAULT_CONFIG: ranked top-k alone always returns
   * a "nearest" memory even when no memory is actually relevant.
   */
  semanticScoreThreshold?: number;
  /** Number of recent user turns kept as native question/final-answer endpoints on the host context surface. */
  freshTurnCount: number;
  embedding?: EmbeddingConfig;
  llm?: {
    apiKey?: string;
    baseURL?: string;
    /** Alias used by OpenClaw and several OpenAI-compatible providers. */
    baseUrl?: string;
    model?: string;
    /** Required only for direct Anthropic REST calls, whose protocol requires a response cap. */
    maxTokens?: number;
  };
  /** PageRank 阻尼系数 */
  pagerankDamping: number;
  /** PageRank 迭代次数 */
  pagerankIterations: number;
}

export const DEFAULT_CONFIG: GmConfig = {
  dbPath: "~/.openclaw/graph-memory.db",
  compactTurnCount: 6,
  recallMaxNodes: 6,
  // Automatic prompt injection optimizes for precision. On the existing
  // text-embedding-v4 20-turn corpus, 0.70 sits above the p90 different-turn
  // similarity (0.669) and near the same-turn median (0.721). Other embedding
  // providers can override this single documented policy value.
  semanticScoreThreshold: 0.70,
  freshTurnCount: 5,
  pagerankDamping: 0.85,
  pagerankIterations: 20,
};
