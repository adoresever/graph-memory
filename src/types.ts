/**
 * graph-memory-pro v2.1 — 类型定义
 *
 * Label 体系：Task / Skill / Event / Community
 * 去掉 Signal 类型，去掉 GmNode 统一 label
 */

// ─── 节点 ─────────────────────────────────────────────────────

export type NodeType = "TASK" | "SKILL" | "EVENT";
export type NodeStatus = "active" | "deprecated";

/**
 * 记忆分层 tier（与 NodeStatus 正交）。
 * decay 评分模型据此双向转换：core↔working↔peripheral。
 * 节点通常保持 status=active，仅 tier 变化；status=deprecated 由手动弃用、
 * merge 或 decay 自动弃用（autoDeprecate，见 DecayConfig）触发。
 */
export type NodeTier = "core" | "working" | "peripheral";

/**
 * 弃用来源标记（节点属性 deprecatedBy）：
 * - decay：遗忘曲线自动弃用（tier=peripheral + 低 composite + 超期未访问）；
 *   重新提取/编辑命中时可自动复活回 active。
 * - manual：gm_update mode=deprecate / finalize invalidations / REST DELETE；
 *   人工语义判定，不自动复活。
 * - merge：dedup 或手动合并的败者节点，不自动复活。
 * 缺省（存量数据）按 manual 处理——不复活；硬删判定只看 deprecatedAt/updatedAt。
 */
export type DeprecatedBy = "decay" | "manual" | "merge";

/** Neo4j label 映射：TASK->Task, SKILL->Skill, EVENT->Event */
export const NODE_TYPE_TO_LABEL: Record<NodeType, string> = {
  TASK: "Task",
  SKILL: "Skill",
  EVENT: "Event",
};

export interface GmNode {
  id: string;
  type: NodeType;
  name: string;
  description: string;
  content: string;
  status: NodeStatus;
  /** 与 NodeStatus 正交的衰减分层；旧节点/新节点缺省时按 working 处理。 */
  tier?: NodeTier;
  validatedCount: number;
  sourceSessions: string[];
  communityId: string | null;
  pagerank: number;
  createdAt: number;
  updatedAt: number;
  /**
   * 最近一次"相关性活动"时间戳（epoch ms），由 upsertNode 在任意写入路径刷新
   * （重新提取、gm_record、gm_update、CRUD POST）。是衰减判定的基准。
   * 与 updatedAt 的区别：updatedAt 在 deprecate/merge 时也会变，不能代表相关性；
   * 而 mergeNodes 故意不更新 lastAccessedAt（合并 ≠ 用户重新激活）。
   * 缺省时回退到 updatedAt / createdAt。
   */
  lastAccessedAt?: number;
  /** 最近一次 decay 评分（0~1，越大越鲜活/重要）。仅 applyDecay 写入。 */
  decayScore?: number;
  /** decayScore 的计算时间戳（epoch ms）。 */
  decayComputedAt?: number;
  /** 被标记 deprecated 的时刻（epoch ms）。硬删倒计时（purgeAfterDays）的基准。 */
  deprecatedAt?: number;
  /** 弃用来源（见 DeprecatedBy）；缺省按 manual 处理。 */
  deprecatedBy?: DeprecatedBy;
}

// ─── 边 ───────────────────────────────────────────────────────

export const EDGE_TYPES = [
  "USED_SKILL",
  "SOLVED_BY",
  "REQUIRES",
  "PATCHES",
  "CONFLICTS_WITH",
] as const;

export type EdgeType = (typeof EDGE_TYPES)[number];

export const EDGE_DIRECTION_RULES: Record<EdgeType, {
  from: readonly NodeType[];
  to: readonly NodeType[];
}> = {
  USED_SKILL:     { from: ["TASK"], to: ["SKILL"] },
  SOLVED_BY:      { from: ["EVENT", "SKILL"], to: ["SKILL"] },
  REQUIRES:       { from: ["SKILL"], to: ["SKILL"] },
  PATCHES:        { from: ["SKILL"], to: ["SKILL"] },
  CONFLICTS_WITH: { from: ["SKILL"], to: ["SKILL"] },
};

/** 运行时校验关系白名单及端点方向（LLM/HTTP 输入不能依赖 TS 类型）。 */
export function isValidEdgeDirection(
  type: string,
  fromType: string,
  toType: string,
): type is EdgeType {
  const rule = EDGE_DIRECTION_RULES[type as EdgeType];
  return !!rule
    && rule.from.includes(fromType as NodeType)
    && rule.to.includes(toType as NodeType);
}

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

// ─── 衰减（柔性评分模型）配置 ─────────────────────────────────
//
// 完整公式、字段映射、默认值来源、调参指南见 docs/decay.md。
// 评分和 tier 转换逻辑实现在 src/graph/decay.ts。

export interface DecayConfig {
  enabled: boolean;
  recencyHalfLifeDays: number;
  recencyWeight: number;
  importanceModulation: number;
  frequencyWeight: number;
  intrinsicWeight: number;
  betaCore: number;
  betaWorking: number;
  betaPeripheral: number;
  coreAccessThreshold: number;
  coreCompositeThreshold: number;
  coreImportanceThreshold: number;
  peripheralCompositeThreshold: number;
  peripheralAgeDays: number;
  workingAccessThreshold: number;
  workingCompositeThreshold: number;
  /**
   * 遗忘曲线自动弃用开关（两阶段生命周期的第一阶段）：
   * tier=peripheral 且 composite < peripheralCompositeThreshold 且
   * lastAccessedAt 距今 ≥ autoDeprecateAfterDays 的节点在维护时被断联 + deprecated。
   * 受 enabled 总开关约束（enabled=false 时整体跳过）。
   */
  autoDeprecate: boolean;
  /** 自动弃用的未访问天数门槛（距 lastAccessedAt）。 */
  autoDeprecateAfterDays: number;
  /**
   * 两阶段生命周期的第二阶段：deprecated 节点自 deprecatedAt（缺省回退 updatedAt）
   * 起超过该天数后硬删（DETACH DELETE，向量随节点一并移除）。
   * 0 = 永不硬删。适用于所有 deprecated 节点（含 manual/merge）。
   */
  purgeAfterDays: number;
}

// ─── cron 会话（定时任务）的图谱行为配置 ─────────────────────

/**
 * 判断是否为 cron 定时会话。host 把 cron 标记放在 sessionKey 上（sessionId 是随机 UUID），
 * 实际形状：cron:<jobId> / agent:<agentId>:cron:<jobId> / agent:<agentId>:cron:<jobId>:run:<runId>。
 * 按段匹配（split(":") 后包含 "cron"），避免误匹配 "cron-daily" 这类自定义段。
 * 注意：cron 任务若显式设置了自定义 sessionKey，host 不再附加 cron 段，此类会话无法识别（见 README）。
 * cron session 的图谱行为（召回/消息入库、知识提取、结束维护）可由 `cron` 配置独立开关；非 cron session 不受影响。
 */
export function isCronSessionKey(sessionKey: string | undefined | null): boolean {
  return typeof sessionKey === "string" && sessionKey.split(":").includes("cron");
}

export interface CronConfig {
  enabled: boolean;
  extract: boolean;
  finalizeAndMaintain: boolean;
}

export const DEFAULT_CRON_CONFIG: CronConfig = {
  enabled: true,
  extract: true,
  finalizeAndMaintain: true,
};

// ─── 原始消息保留（opt-in 有界清理）──────────────────────────
//
// 设计原则（移植自上游 #96）："上下文压缩改变的是模型可见面，
// 不构成删除持久证据的授权。" 默认 keep=all 零行为变化；
// 清理逻辑实现在 src/store/retention.ts，挂在 runMaintenance 尾部。

export type MessageRetentionMode = "all" | "referenced" | "recent";

export interface MessageRetentionConfig {
  /**
   * all（默认）保留全部原始消息，零开销；
   * referenced 只删"已提取完成且实际产出知识"的消息（producedKnowledge=true，
   * 知识已固化进图谱，原始文本退役；LLM 空提取的轮次保留原始证据，
   * 重挖需手动重置 extracted 后跑 graph-memory extract）；
   * recent 在 referenced 的基础上按时间窗保护最近内容。
   */
  keep?: MessageRetentionMode;
  /** keep=recent：每个 session 保留最近 N 轮真实用户发言（该轮及其后全部保留）。 */
  recentTurns?: number;
  /** keep=recent：保留最近 N 天内入库的消息。 */
  retentionDays?: number;
  /** 单个维护周期最多处理的行数（保证维护链工作有界）。默认 500。 */
  batchSize?: number;
  /** true 时只报告候选集不删除 —— 启用前先跑一轮 dryRun 验证。 */
  dryRun?: boolean;
}

// ─── 知识提取配置（LLM 成本控制）─────────────────────────────

export interface ExtractConfig {
  /**
   * 提取模式：
   * - per-turn（默认）：每轮 afterTurn/commitTurn 即时 LLM 提取（知识实时入库）；
   * - batched：攒批提取——trivial 轮本地标记跳过，未提取消息累计到
   *   compactTurnCount*3 条时批量提取一次，session_end 冲洗尾批。
   *   LLM 调用次数降为 per-turn 的 ~1/N，代价是会话中途召回不到本会话最新知识。
   */
  mode?: "per-turn" | "batched";
  /**
   * 本地预筛阈值：用户输入清洗（去空白/标点）后长度 ≤ 该值且不含技术词
   * （连续 ≥3 位字母数字，如 pnpm/jwt）时，跳过 LLM 提取直接标记。
   * 保守默认 5（中文 5 字以内基本不可能承载可提取知识）。
   * 例外：轮内含工具劳动（tool/toolResult 角色）时不判 trivial——"继续"触发的
   * 一轮真实修复劳动恰是可提取知识，不误杀（见 turn-filter.ts 的 turnHasToolWork）。
   */
  trivialMaxChars?: number;
  /** 额外无意义词表（与内置表合并，清洗后小写精确匹配，如 "继续"、"resume"）。 */
  trivialPrompts?: string[];
}

// ─── 插件配置 ─────────────────────────────────────────────────

export interface GmConfig {
  neo4j: Neo4jConfig;
  compactTurnCount: number;
  recallMaxNodes: number;
  recallMaxDepth: number;
  /** assemble 保留的最近轮数（裁剪窗口）；默认 5，与 sliceLastTurn 的回退值一致。 */
  freshTailCount: number;
  embedding?: EmbeddingConfig;
  llm?: {
    provider?: "openai" | "anthropic" | "oauth";
    apiKey?: string;
    baseURL?: string;
    model?: string;
    timeoutMs?: number;
    maxTokens?: number;
    /** OAuth 会话文件路径（provider="oauth" 时必填）。 */
    oauthPath?: string;
    /** OAuth 提供商标识（默认 "openai-codex"）。 */
    oauthProvider?: string;
    /** 推理模型思考强度（仅 oauth provider 生效；默认 "medium"）。 */
    reasoningEffort?: "low" | "medium" | "high";
  };
  dedupThreshold: number;
  pagerankDamping: number;
  pagerankIterations: number;
  /** 遗忘曲线衰减配置；未提供时使用 DEFAULT_CONFIG.decay。 */
  decay?: DecayConfig;
  /** 知识提取配置（模式 + trivial 预筛）；未提供时 per-turn + 默认预筛。 */
  extract?: ExtractConfig;
  cron?: CronConfig;
  /** 原始消息保留策略；未提供时等价 keep=all（永不删除）。 */
  messageRetention?: MessageRetentionConfig;
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
  freshTailCount: 5,
  dedupThreshold: 0.90,
  pagerankDamping: 0.85,
  pagerankIterations: 20,
  decay: {
    enabled: true,
    recencyHalfLifeDays: 30,
    recencyWeight: 0.4,
    importanceModulation: 1.5,
    frequencyWeight: 0.3,
    intrinsicWeight: 0.3,
    betaCore: 0.8,
    betaWorking: 1.0,
    betaPeripheral: 1.3,
    coreAccessThreshold: 10,
    coreCompositeThreshold: 0.7,
    coreImportanceThreshold: 0.8,
    peripheralCompositeThreshold: 0.15,
    peripheralAgeDays: 60,
    workingAccessThreshold: 3,
    workingCompositeThreshold: 0.4,
    autoDeprecate: true,
    autoDeprecateAfterDays: 30,
    purgeAfterDays: 60,
  },
  cron: DEFAULT_CRON_CONFIG,
  extract: {
    mode: "per-turn",
    trivialMaxChars: 5,
  },
};
