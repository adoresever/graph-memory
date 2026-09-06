/**
 * graph-memory-pro CLI — `openclaw graph-memory extract`
 *
 * 对未被提取的会话消息做批量图谱提取，补齐因 compact 未触发、提取失败或
 * 进程退出而残留的 GmMessage。流程镜像 index.ts 的 compact() 路径：
 *   getUnextracted → extractor.extract → upsertNode + syncEmbed → upsertEdge → markExtracted
 *
 * 命令在 cli-metadata 模式下运行（register() 早早 return），所以这里必须自行
 * 完成 Neo4j driver / schema / LLM / embedder / Extractor / Recaller 的初始化。
 */

import type { Driver } from "neo4j-driver";
import type { GmConfig } from "./types.ts";
import { getDriver, initSchema, closeDriver } from "./store/db.ts";
import {
  listUnextractedSessions,
  getUnextracted,
  markExtracted,
  getBySession,
  type UnextractedSessionInfo,
} from "./store/store.ts";
import { createCompleteFn, resolveProvider } from "./engine/llm.ts";
import { createEmbedder } from "./engine/embed.ts";
import { Recaller } from "./recaller/recall.ts";
import { Extractor } from "./extractor/extract.ts";
import { persistExtractionResult } from "./extractor/persist.ts";
import { defaultLog, makeDefaultPrompt } from "./cli-io.ts";

const AFFIRMATIVE = new Set(["y", "yes", "yeah", "yep", "ok", "okay", "true", "1", "confirm"]);

export function isAffirmative(answer: string): boolean {
  return AFFIRMATIVE.has(answer.trim().toLowerCase());
}

export interface BackfillExtractOptions {
  yes?: boolean;
  limit?: number;
  session?: string;
  dryRun?: boolean;
}

export interface BackfillExtractParams {
  cfg: GmConfig;
  effectiveModel: string;
  options: BackfillExtractOptions;
  log?: (msg: string) => void;
  prompt?: (question: string) => Promise<string>;
}

export interface BackfillExtractResult {
  sessionsTotal: number;
  sessionsProcessed: number;
  sessionsSkipped: number;
  nodesCreated: number;
  edgesCreated: number;
  batches: number;
  durationMs: number;
}

const DEFAULT_BATCH_LIMIT_MULTIPLIER = 3;

function formatSessionLine(info: UnextractedSessionInfo, index: number): string {
  const created = info.minCreatedAt > 0
    ? new Date(info.minCreatedAt).toISOString().replace("T", " ").slice(0, 19)
    : "?";
  return `  ${String(index + 1).padStart(3, " ")}. sid=${info.sessionId.slice(0, 12)}…  msgs=${info.messageCount}  maxTurn=${info.maxTurn}  since=${created}`;
}

export async function runBackfillExtraction(
  params: BackfillExtractParams,
): Promise<BackfillExtractResult> {
  const start = Date.now();
  const log = params.log ?? defaultLog;
  const opts = params.options;
  const cfg = params.cfg;

  const result: BackfillExtractResult = {
    sessionsTotal: 0,
    sessionsProcessed: 0,
    sessionsSkipped: 0,
    nodesCreated: 0,
    edgesCreated: 0,
    batches: 0,
    durationMs: 0,
  };

  if (!cfg.neo4j?.uri) {
    throw new Error(
      "[graph-memory-pro] extract 需要 neo4j.uri 配置。请在 graph-memory-pro 插件配置中设置 neo4j.uri / neo4j.user / neo4j.password。",
    );
  }

  if (!params.effectiveModel) {
    throw new Error(
      "[graph-memory-pro] extract 需要一个 LLM model。请在 config.llm.model 或 agents.defaults.model 中设置。",
    );
  }

  const providerInfo = resolveProvider(cfg.llm);
  if (providerInfo.provider === "anthropic" && !cfg.llm?.apiKey) {
    throw new Error("[graph-memory-pro] llm.provider=anthropic 但未配 llm.apiKey，无法提取。");
  }
  if (providerInfo.provider === "openai" && (!cfg.llm?.apiKey || !cfg.llm?.baseURL)) {
    throw new Error("[graph-memory-pro] llm.provider=openai 需要 llm.apiKey + llm.baseURL，无法提取。");
  }
  if (providerInfo.provider === "oauth" && !cfg.llm?.oauthPath) {
    throw new Error(
      "[graph-memory-pro] llm.provider=oauth 但未配 llm.oauthPath。请先运行 `openclaw graph-memory auth login`。",
    );
  }

  const driver: Driver = getDriver(cfg.neo4j);

  try {
    log("[graph-memory-pro] 正在初始化 Neo4j schema...");
    await initSchema(driver, cfg.embedding);

    log("[graph-memory-pro] 正在初始化 LLM 与 embedder...");
    const llm = createCompleteFn(params.effectiveModel, cfg.llm);
    const extractor = new Extractor(llm);
    const recaller = new Recaller(driver, cfg);
    const embedder = await createEmbedder(cfg.embedding);
    if (embedder) {
      recaller.setEmbedFn(embedder.embed);
      recaller.setEmbedBatchFn(embedder.embedBatch);
      log("[graph-memory-pro] embedding 已就绪，新节点将批量同步向量。");
    } else {
      log("[graph-memory-pro] 未配置 embedding，跳过向量同步（dual-path recall 会降级为文本搜索）。");
    }

    let sessions = await listUnextractedSessions(driver);
    if (opts.session) {
      sessions = sessions.filter(s => s.sessionId === opts.session);
      if (!sessions.length) {
        log(`[graph-memory-pro] --session=${opts.session} 没有匹配到含未提取消息的会话。`);
        result.durationMs = Date.now() - start;
        return result;
      }
    }
    result.sessionsTotal = sessions.length;

    if (sessions.length === 0) {
      log("[graph-memory-pro] 没有需要提取的会话。");
      result.durationMs = Date.now() - start;
      return result;
    }

    const totalMessages = sessions.reduce((s, info) => s + info.messageCount, 0);
    log(`[graph-memory-pro] 发现 ${sessions.length} 个会话共 ${totalMessages} 条未提取消息：`);
    sessions.forEach((info, i) => log(formatSessionLine(info, i)));

    if (opts.dryRun) {
      log("[graph-memory-pro] --dry-run 模式，未执行提取。");
      result.sessionsSkipped = sessions.length;
      result.durationMs = Date.now() - start;
      return result;
    }

    if (!opts.yes) {
      const prompt = params.prompt ?? makeDefaultPrompt("GRAPH_MEMORY_EXTRACT_CONFIRM");
      const answer = await prompt(`\n将对以上 ${sessions.length} 个会话发起 LLM 提取，继续？[y/N] `);
      if (!isAffirmative(answer)) {
        log("[graph-memory-pro] 已取消。");
        result.sessionsSkipped = sessions.length;
        result.durationMs = Date.now() - start;
        return result;
      }
    }

    const batchLimit = opts.limit && opts.limit > 0
      ? opts.limit
      : Math.max(1, cfg.compactTurnCount) * DEFAULT_BATCH_LIMIT_MULTIPLIER;

    log(`\n[graph-memory-pro] 开始提取（每批最多 ${batchLimit} 条消息）...`);

    for (const info of sessions) {
      log(`\n[graph-memory-pro] 会话 ${info.sessionId.slice(0, 12)}… (${info.messageCount} 条消息)`);
      try {
        const processed = await extractSessionLoop(driver, extractor, recaller, info.sessionId, batchLimit, log);
        result.nodesCreated += processed.nodes;
        result.edgesCreated += processed.edges;
        result.batches += processed.batches;
        result.sessionsProcessed += 1;
        log(`  -> 完成：${processed.nodes} 节点 / ${processed.edges} 边 / ${processed.batches} 批`);
      } catch (err) {
        result.sessionsSkipped += 1;
        log(`  -> 失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    result.durationMs = Date.now() - start;

    log(
      `\n[graph-memory-pro] 提取完成：${result.sessionsProcessed}/${result.sessionsTotal} 会话，` +
      `${result.nodesCreated} 节点，${result.edgesCreated} 边，${result.batches} 批，` +
      `用时 ${(result.durationMs / 1000).toFixed(1)}s`,
    );
    return result;
  } finally {
    await closeDriver();
  }
}

interface SessionExtractStats {
  nodes: number;
  edges: number;
  batches: number;
}

async function extractSessionLoop(
  driver: Driver,
  extractor: Extractor,
  recaller: Recaller,
  sessionId: string,
  batchLimit: number,
  log: (msg: string) => void,
): Promise<SessionExtractStats> {
  const stats: SessionExtractStats = { nodes: 0, edges: 0, batches: 0 };
  const hardBatchCeiling = 50;
  let exhausted = false;

  for (let i = 0; i < hardBatchCeiling; i++) {
    const msgs = await getUnextracted(driver, sessionId, batchLimit);
    if (!msgs.length) break;

    stats.batches += 1;
    const existing = (await getBySession(driver, sessionId)).map(n => n.name);
    const extraction = await extractor.extract({ messages: msgs, existingNames: existing });

    // awaitEmbedSync=true：closeDriver 在 finally 里执行，最后一批的 embedding
    // 请求必须等完 —— 不等待会撞上已关闭的 driver 且错误被吞
    // （markExtracted 已执行，重跑 extract 不会补向量）。
    const outcome = await persistExtractionResult(driver, recaller, extraction, {
      sessionId,
      awaitEmbedSync: true,
      onNodeUpserted: () => { stats.nodes += 1; },
    });
    stats.edges += outcome.edges;

    const maxTurn = msgs.reduce((m, msg) => Math.max(m, msg.turn_index ?? 0), 0);
    await markExtracted(
      driver, sessionId, maxTurn,
      extraction.nodes.length > 0 || extraction.edges.length > 0,
    );
    log(`  batch ${stats.batches}: ${msgs.length} 消息 -> ${extraction.nodes.length} 节点 / ${extraction.edges.length} 边（累计 ${stats.nodes}/${stats.edges}）`);

    if (msgs.length < batchLimit) break;
    if (i === hardBatchCeiling - 1) exhausted = true;
  }

  if (exhausted) {
    log(`  警告：达到批数上限 ${hardBatchCeiling}，会话 ${sessionId.slice(0, 12)}… 仍有未提取消息，请再次运行。`);
  }

  return stats;
}
