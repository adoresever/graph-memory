/**
 * graph-memory — Knowledge Graph Memory plugin for OpenClaw
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 *
 * v1.1.0：
 *   - 去掉 signals 机制，每轮直接提取
 *   - content 模板改为纯文本（无 markdown）
 *   - 提取规则放宽：讨论、分析、对比也会提取
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { getDb } from "./src/store/db.ts";
import {
  saveMessage, markMessagesExtracted,
  quarantineMessages, recordExtractionFailure,
  upsertNode, upsertEdge, findByName, updateNode,
  getBySession,
  deprecate, getStats,
  upsertTurnMemory,
  getRecentTurnMemoriesBySession,
  replaceNavigationTriples,
} from "./src/store/store.ts";
import { createCompleteFn } from "./src/engine/llm.ts";
import { createEmbedFn } from "./src/engine/embed.ts";
import { Recaller } from "./src/recaller/recall.ts";
import { Extractor } from "./src/extractor/extract.ts";
import { assembleContext } from "./src/format/assemble.ts";
import { runMaintenance } from "./src/graph/maintenance.ts";
import { invalidateGraphCache, computeGlobalPageRank } from "./src/graph/pagerank.ts";
import { detectCommunities, detectNavigationCommunities } from "./src/graph/community.ts";
import { DEFAULT_CONFIG, type GmConfig, type RecallResult } from "./src/types.ts";

// ─── 从 OpenClaw config 读 provider/model ────────────────────

function readProviderModel(apiConfig: unknown): { provider: string; model: string } {
  let raw = "";

  if (apiConfig && typeof apiConfig === "object") {
    const m = (apiConfig as any).agents?.defaults?.model;
    if (typeof m === "string" && m.trim()) {
      raw = m.trim();
    } else if (m && typeof m === "object" && typeof m.primary === "string" && m.primary.trim()) {
      raw = m.primary.trim();
    }
  }

  if (raw.includes("/")) {
    const [provider, ...rest] = raw.split("/");
    const model = rest.join("/").trim();
    if (provider?.trim() && model) {
      return { provider: provider.trim(), model };
    }
  }

  if (raw) {
    return { provider: "anthropic", model: raw };
  }

  return { provider: "", model: "" };
}

// ─── 清洗 OpenClaw metadata 包装 ─────────────────────────────

function cleanPrompt(raw: string): string {
  let prompt = raw.trim();

  if (prompt.includes("Sender (untrusted metadata)")) {
    const jsonStart = prompt.indexOf("```json");
    if (jsonStart >= 0) {
      const jsonEnd = prompt.indexOf("```", jsonStart + 7);
      if (jsonEnd >= 0) {
        prompt = prompt.slice(jsonEnd + 3).trim();
      }
    }
    if (prompt.includes("Sender (untrusted metadata)")) {
      const lines = prompt.split("\n").filter(l => l.trim() && !l.includes("Sender") && !l.startsWith("```") && !l.startsWith("{"));
      prompt = lines.join("\n").trim();
    }
  }

  prompt = prompt.replace(/^\/\w+\s+/, "").trim();
  prompt = prompt.replace(/^\[[\w\s\-:]+\]\s*/, "").trim();

  return prompt;
}

// ─── 规范化消息 content，确保 OpenClaw 对 content.filter() 不崩 ──

function normalizeMessageContent(messages: any[]): any[] {
  return messages.map((msg: any) => {
    if (!msg || typeof msg !== "object") return msg;
    const c = msg.content;
    // 已经是数组 → 修复畸形 block（如 { type: "text" } 缺 text 属性）
    if (Array.isArray(c)) {
      const fixed = c.map((block: any) => {
        if (block && typeof block === "object" && block.type === "text" && !("text" in block)) {
          return { ...block, text: "" };
        }
        return block;
      });
      if (fixed !== c) return { ...msg, content: fixed };
      return msg;
    }
    // string → 包装成标准 content block 数组
    if (typeof c === "string") {
      return { ...msg, content: [{ type: "text", text: c }] };
    }
    // undefined/null → 空 text block
    if (c == null) {
      return { ...msg, content: [{ type: "text", text: "" }] };
    }
    return msg;
  });
}

/** Return only the completed-turn messages not already delivered by ingest(). */
export function missingIngestMessages(messages: any[], ingestedCount: number): any[] {
  const delivered = Math.max(0, Math.min(messages.length, ingestedCount));
  return messages.slice(delivered);
}

// ─── 插件对象 ─────────────────────────────────────────────────

let activeEngine: any | null = null;

const graphMemoryPlugin = {
  id: "graph-memory",
  name: "Graph Memory",
  description:
    "知识图谱记忆引擎：从对话提取三元组，FTS5+图遍历+PageRank 跨对话召回，社区聚类维护",

  register(api: OpenClawPluginApi) {
    // Some host builds have called register() repeatedly without disposing the
    // previous engine. Re-registering every hook/tool retains native SQLite
    // statements and multiplies work for every turn. Rebind only the engine
    // factory until OpenClaw calls dispose() for a genuine reload.
    if (activeEngine) {
      api.registerContextEngine("graph-memory", () => activeEngine);
      api.logger.warn("[graph-memory] duplicate register() ignored; reusing active engine");
      return;
    }

    // ── 读配置 ──────────────────────────────────────────────
    const raw =
      api.pluginConfig && typeof api.pluginConfig === "object"
        ? (api.pluginConfig as any)
        : {};
    const cfg: GmConfig = {
      ...DEFAULT_CONFIG,
      ...raw,
      // An omitted/undefined threshold must never turn automatic semantic
      // recall into unconditional nearest-neighbour injection.
      semanticScoreThreshold: raw.semanticScoreThreshold ?? DEFAULT_CONFIG.semanticScoreThreshold,
    };
    const { provider, model } = readProviderModel(api.config);

    const effectiveModel = cfg.llm?.model ?? model;
    if (!effectiveModel) {
      api.logger.warn(
        "[graph-memory] No LLM model configured. Set agents.defaults.model in openclaw.json " +
        "or config.llm.model in graph-memory plugin config — extraction will fail.",
      );
    }

    // ── 初始化核心模块 ──────────────────────────────────────
    const db = getDb(cfg.dbPath);
    const configuredLlmBaseURL = cfg.llm?.baseURL ?? cfg.llm?.baseUrl;
    const anthropicApiKey = cfg.llm?.apiKey && !configuredLlmBaseURL
      ? cfg.llm.apiKey   // If apiKey set but no baseURL, assume Anthropic direct
      : undefined;
    const llm = createCompleteFn(provider, model, cfg.llm, anthropicApiKey);
    const recaller = new Recaller(db, cfg);
    const extractor = new Extractor(cfg, llm);

    // ── 初始化 embedding ────────────────────────────────────
    const embeddingReady: Promise<void> = createEmbedFn(cfg.embedding)
      .then((fn) => {
        if (fn) {
          recaller.setEmbedFn(fn);
          api.logger.info("[graph-memory] vector search ready");
        } else {
          api.logger.info("[graph-memory] FTS5 search mode (配置 embedding 可启用语义搜索)");
        }
      })
      .catch(() => {
        api.logger.info("[graph-memory] FTS5 search mode");
      });

    // ── Session 运行时状态 ──────────────────────────────────
    const msgSeq = new Map<string, number>();
    const recalled = new Map<string, RecallResult>();
    const turnCounter = new Map<string, number>(); // 社区维护计数器
    const ingestedRowsSinceTurn = new Map<string, any[]>();

    // ── 提取串行化（同 session Promise chain，不同 session 并行）────
    const extractChain = new Map<string, Promise<void>>();

    /** 存一条消息到 gm_messages（同步，零 LLM） */
    function ingestMessage(sessionId: string, message: any): any {
      let seq = msgSeq.get(sessionId);
      if (seq === undefined) {
        // 首次入库：从数据库读取当前最大 turn_index，避免重启后 turn_index 重叠
        const row = db.prepare(
          "SELECT MAX(turn_index) as maxTurn FROM gm_messages WHERE session_id=?"
        ).get(sessionId) as any;
        seq = Number(row?.maxTurn) || 0;
      }
      seq += 1;
      msgSeq.set(sessionId, seq);
      const id = saveMessage(db, sessionId, seq, message.role ?? "unknown", message);
      return { ...message, id, turn_index: seq, role: message.role ?? "unknown" };
    }

    /** 每轮结束后只提取本轮的完整问答；失败隔离，不在下一轮隐式重试。 */
    async function runTurnExtract(sessionId: string, turnRows: any[]): Promise<void> {
      if (!turnRows.length) return;

      // Promise chain：上一次提取完了才跑下一次，不会跳过
      const prev = extractChain.get(sessionId) ?? Promise.resolve();
      const next = prev.then(async () => {
        const messageIds = turnRows.map(message => String(message.id));
        try {
          const sourcePairs = projectCompletedTurnPairs(turnRows);
          if (!sourcePairs.length) {
            markMessagesExtracted(db, messageIds);
            return;
          }
          const currentTurn = Math.min(...sourcePairs.map(message => Number(message.turn_index)));
          const result = await extractor.extract({
            messages: sourcePairs,
            priorTurns: Number.isFinite(currentTurn)
              ? getRecentTurnMemoriesBySession(db, sessionId, currentTurn, cfg.freshTurnCount)
              : [],
          });

          const turnMemory = upsertTurnMemory(db, {
            sessionId,
            summary: result.turn.summary,
            outcome: result.turn.outcome,
            // The capsule retains both original endpoints as one auditable
            // evidence bundle; triples navigate back to this memory id.
            sources: sourcePairs.map(message => ({
              messageId: String(message.id),
              turnIndex: Number(message.turn_index),
            })),
          });
          replaceNavigationTriples(db, turnMemory, result.triples);
          // Recompute the compact navigation partition only after the SPO
          // transaction lands. This is in the per-session background worker,
          // so it adds no model call and cannot block the user's response.
          invalidateGraphCache(db);
          const navigationCommunities = detectNavigationCommunities(db);
          embeddingReady
            .then(() => recaller.syncTurnMemoryEmbed(turnMemory))
            .catch(() => {});

          markMessagesExtracted(db, messageIds);
          api.logger.info(
            `[graph-memory] stored one turn summary and ${result.triples.length} navigation triples ` +
            `(${navigationCommunities.count} local communities)`,
          );
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          recordExtractionFailure(db, messageIds, error.message, null);
          quarantineMessages(db, messageIds, error.message);
          api.logger.error(`[graph-memory] turn extract failed: ${err}`);
          // 失败不阻塞下一轮，但也不会被下一轮自动重试。
        }
      });
      extractChain.set(sessionId, next);
      return next;
    }

    // ── before_prompt_build：召回 ────────────────────────────

    api.on("before_prompt_build", async (event: any, ctx: any) => {
      try {
        const rawPrompt = typeof event?.prompt === "string" ? event.prompt : "";
        const prompt = cleanPrompt(rawPrompt);
        if (!prompt) return;
        if (prompt.includes("/new or /reset") || prompt.includes("new session was started")) return;

        const sid = ctx?.sessionId ?? ctx?.sessionKey;

        api.logger.info(`[graph-memory] recall query accepted (${prompt.length} characters)`);

        await embeddingReady;
        const res = await recaller.recall(prompt);
        if (res.nodes.length || res.turnMemories.length) {
          if (ctx?.sessionId) recalled.set(ctx.sessionId, res);
          if (ctx?.sessionKey && ctx.sessionKey !== ctx?.sessionId) {
            recalled.set(ctx.sessionKey, res);
          }
          api.logger.info(
            `[graph-memory] recalled ${res.turnMemories.length} turn memories, ` +
            `${res.nodes.length} nodes, ${res.edges.length} edges`,
          );
        }
      } catch (err) {
        api.logger.warn(`[graph-memory] recall failed: ${err}`);
      }
    });

    // ── ContextEngine ────────────────────────────────────────

    const engine = {
      info: {
        id: "graph-memory",
        name: "Graph Memory",
        ownsCompaction: true,
      },

      async bootstrap({ sessionId }: { sessionId: string }) {
        return { bootstrapped: true };
      },

      async ingest({
        sessionId,
        message,
        isHeartbeat,
      }: {
        sessionId: string;
        message: any;
        isHeartbeat?: boolean;
      }) {
        if (isHeartbeat) return { ingested: false };
        const rows = ingestedRowsSinceTurn.get(sessionId) ?? [];
        rows.push(ingestMessage(sessionId, message));
        ingestedRowsSinceTurn.set(sessionId, rows);
        return { ingested: true };
      },

      async assemble({
        sessionId,
        messages,
        tokenBudget,
        prompt,
      }: {
        sessionId: string;
        messages: any[];
        tokenBudget?: number;
        prompt?: string;  // Added in OpenClaw 2026.03.28: prompt-aware retrieval
      }) {
        // OpenClaw 2026.03.28: use the prompt for a fresh, accurate recall
        // at assembly time instead of relying solely on the pre-cached result
        // from before_agent_start.
        let rec = recalled.get(sessionId) ?? { nodes: [], edges: [], turnMemories: [], triples: [] };
        if (prompt) {
          const cleaned = cleanPrompt(prompt);
          if (cleaned) {
            try {
              await embeddingReady;
              const freshRec = await recaller.recall(cleaned);
              if (freshRec.nodes.length || freshRec.turnMemories.length) {
                rec = freshRec;
                recalled.set(sessionId, freshRec);
              }
            } catch (err) {
              api.logger.warn(`[graph-memory] assemble recall failed: ${err}`);
              // fall through to cached rec
            }
          }
        }
        // ── 1. 近期问题 + 最终回答；工具/推理轨迹不回灌上下文 ──
        const lastTurn = projectRecentTurns(messages, cfg.freshTurnCount);

        if (rec.nodes.length === 0 && rec.turnMemories.length === 0) {
          return { messages: normalizeMessageContent(lastTurn.messages), estimatedTokens: 0 };
        }

        // ── 2. 图谱 + 溯源 ─────────────────────────────
        const { xml, systemPrompt, memoryXml, episodicXml } = assembleContext(db, {
          recalledNodes: rec.nodes,
          recalledEdges: rec.edges,
          recalledMemories: rec.turnMemories,
          recalledTriples: rec.triples,
          freshTurnCount: cfg.freshTurnCount,
        });

        if (lastTurn.dropped > 0 || episodicXml) {
          api.logger.info(
            `[graph-memory] assemble: retained ${lastTurn.messages.length} projected messages, ` +
            `removed ${lastTurn.dropped} older/intermediate messages` +
            (episodicXml ? ", attached exact recalled evidence" : ""),
          );
        }

        // ── 3. 组装 systemPrompt ────────────────────────
        let systemPromptAddition: string | undefined;
        const parts = [systemPrompt, memoryXml, xml, episodicXml].filter(Boolean);
        if (parts.length) {
          systemPromptAddition = parts.join("\n\n");
        }

        return {
          messages: normalizeMessageContent(lastTurn.messages),
          // The host/provider tokenizer owns token accounting. A character
          // divisor is especially inaccurate for CJK, JSON and tool payloads.
          estimatedTokens: 0,
          ...(systemPromptAddition ? { systemPromptAddition } : {}),
        };
      },

      async compact({
        sessionId: _sessionId,
      }: {
        sessionId: string;
        sessionFile: string;
        tokenBudget?: number;
        force?: boolean;
        currentTokenCount?: number;
      }) {
        // Context projection is performed by assemble(); extraction has one
        // owner only: the serialized afterTurn queue.
        return { ok: true, compacted: false, reason: "rolling projection is applied during assemble" };
      },

      async afterTurn({
        sessionId,
        messages,
        prePromptMessageCount,
        isHeartbeat,
      }: {
        sessionId: string;
        sessionFile: string;
        messages: any[];
        prePromptMessageCount: number;
        autoCompactionSummary?: string;
        isHeartbeat?: boolean;
        tokenBudget?: number;
      }) {
        if (isHeartbeat) return;

        // Official OpenClaw calls ingest() and afterTurn() as separate lifecycle
        // phases. A few downstream builds incorrectly treat them as mutually
        // exclusive. Backfill only the messages that ingest() did not deliver.
        const newMessages = messages.slice(prePromptMessageCount ?? 0);
        const turnRows = ingestedRowsSinceTurn.get(sessionId) ?? [];
        const missingMessages = missingIngestMessages(newMessages, turnRows.length);
        if (missingMessages.length > 0) {
          for (const message of missingMessages) {
            turnRows.push(ingestMessage(sessionId, message));
          }
          api.logger.warn(
            `[graph-memory] afterTurn backfilled ${missingMessages.length} message(s) missing from ingest lifecycle`,
          );
        }
        ingestedRowsSinceTurn.delete(sessionId);

        const totalMsgs = msgSeq.get(sessionId) ?? 0;
        api.logger.info(
          `[graph-memory] afterTurn newMsgs=${newMessages.length} totalMsgs=${totalMsgs}`,
        );

        // ★ 每轮直接提取
        runTurnExtract(sessionId, turnRows).catch((err) => {
          api.logger.error(`[graph-memory] turn extract failed: ${err}`);
        });

        // ★ 社区维护：每 N 轮触发一次（纯计算，<5ms）
        const turns = (turnCounter.get(sessionId) ?? 0) + 1;
        turnCounter.set(sessionId, turns);
        const maintainInterval = cfg.compactTurnCount;

        if (turns % maintainInterval === 0) {
          try {
            invalidateGraphCache(db);
            const pr = computeGlobalPageRank(db, cfg);
            const comm = detectCommunities(db);
            const navigationComm = detectNavigationCommunities(db);
            api.logger.info(
              `[graph-memory] periodic maintenance (turn ${turns}): ` +
              `pagerank_candidates=${pr.topK.length}, communities=${comm.count + navigationComm.count}`,
            );

          } catch (err) {
            api.logger.error(`[graph-memory] periodic maintenance failed: ${err}`);
          }
        }
      },

      async prepareSubagentSpawn({
        parentSessionKey,
        childSessionKey,
      }: {
        parentSessionKey: string;
        childSessionKey: string;
      }) {
        const rec = recalled.get(parentSessionKey);
        if (rec) recalled.set(childSessionKey, rec);
        return { rollback: () => { recalled.delete(childSessionKey); } };
      },

      async onSubagentEnded({ childSessionKey }: { childSessionKey: string }) {
        recalled.delete(childSessionKey);
        msgSeq.delete(childSessionKey);
      },

      async dispose() {
        extractChain.clear();
        msgSeq.clear();
        recalled.clear();
        turnCounter.clear();
        ingestedRowsSinceTurn.clear();
        if (activeEngine === engine) activeEngine = null;
      },
    };

    activeEngine = engine;
    api.registerContextEngine("graph-memory", () => engine);

    // ── session_end：确定性的图维护（不再发起二次 LLM 语义改写） ──

    api.on("session_end", async (event: any, ctx: any) => {
      const sid =
        ctx?.sessionKey ??
        ctx?.sessionId ??
        event?.sessionKey ??
        event?.sessionId;
      if (!sid) return;

      try {
        const result = await runMaintenance(db, cfg);
        api.logger.info(
          `[graph-memory] maintenance: ${result.durationMs}ms, ` +
          `communities=${result.community.count + result.navigationCommunity.count}, ` +
          `pagerank_candidates=${result.pagerank.topK.length}`,
        );
      } catch (err) {
        api.logger.error(`[graph-memory] session_end error: ${err}`);
      } finally {
        extractChain.delete(sid);
        msgSeq.delete(sid);
        recalled.delete(sid);
        turnCounter.delete(sid);
        ingestedRowsSinceTurn.delete(sid);
      }
    });

    // ── Agent Tools（改名 gm_*）──────────────────────────────

    api.registerTool(
      (_ctx: any) => ({
        name: "gm_search",
        label: "Search Graph Memory",
        description: "搜索知识图谱中的相关经验、技能和解决方案。遇到可能之前解决过的问题时调用。",
        parameters: Type.Object({
          query: Type.String({ description: "搜索关键词或问题描述" }),
        }),
        async execute(_toolCallId: string, params: { query: string }) {
          const { query } = params;
          await embeddingReady;
          const res = await recaller.recall(query);
          if (!res.nodes.length && !res.turnMemories.length) {
            return {
              content: [{ type: "text", text: "图谱中未找到相关记录。" }],
              details: { count: 0, query },
            };
          }

          const memoryLines = res.turnMemories.map(
            memory => `[TURN ${memory.outcome}] ${memory.summary}`,
          );
          const tripleLines = res.triples.map(
            triple => `${triple.subject} --[${triple.predicate}]--> ${triple.object}`,
          );
          const lines = res.nodes.map(
            (n) => `[${n.type}] ${n.name} (pr:${n.pagerank.toFixed(3)})\n${n.description}\n${n.content}`,
          );
          const edgeLines = res.edges.map((e) => {
            const from = res.nodes.find((n) => n.id === e.fromId)?.name ?? e.fromId;
            const to = res.nodes.find((n) => n.id === e.toId)?.name ?? e.toId;
            return `  ${from} --[${e.type}]--> ${to}: ${e.instruction}`;
          });

          const text = [
            `找到 ${res.nodes.length} 个节点：\n`,
            ...memoryLines,
            ...tripleLines,
            ...lines,
            ...(edgeLines.length ? ["\n关系：", ...edgeLines] : []),
          ].join("\n\n");

          return {
            content: [{ type: "text", text }],
            details: { count: res.nodes.length, query },
          };
        },
      }),
      { name: "gm_search" },
    );

    api.registerTool(
      (ctx: any) => ({
        name: "gm_record",
        label: "Record to Graph Memory",
        description: "手动记录经验到知识图谱。发现重要解法、踩坑经验或工作流程时调用。",
        parameters: Type.Object({
          name: Type.String({ description: "节点名称（全小写连字符）" }),
          type: Type.String({ description: "实体类型：TASK、SKILL 或 EVENT" }),
          description: Type.String({ description: "一句话说明" }),
          content: Type.String({ description: "纯文本格式的知识内容" }),
          relatedSkill: Type.Optional(
            Type.String({ description: "可选：关联的已有技能名（建立 SOLVED_BY 关系）" }),
          ),
        }),
        async execute(
          _toolCallId: string,
          p: { name: string; type: string; description: string; content: string; relatedSkill?: string },
        ) {
          const sid = ctx?.sessionKey ?? ctx?.sessionId ?? "manual";
          const { node } = upsertNode(db, {
            type: p.type as any, name: p.name,
            description: p.description, content: p.content,
          }, sid);
          if (p.relatedSkill) {
            const rel = findByName(db, p.relatedSkill);
            if (rel) {
              upsertEdge(db, {
                fromId: node.id, toId: rel.id, type: "SOLVED_BY",
                instruction: `关联 ${p.relatedSkill}`, sessionId: sid,
              });
            }
          }
          recaller.syncEmbed(node).catch(() => {});
          return {
            content: [{ type: "text", text: `已记录：${node.name} (${node.type})` }],
            details: { name: node.name, type: node.type },
          };
        },
      }),
      { name: "gm_record" },
    );

    api.registerTool(
      (ctx: any) => ({
        name: "gm_update",
        label: "Update Graph Memory Node",
        description:
          "更新知识图谱中已存在的节点。必须提供精确的节点名称（不存在会报错）。用于 refine 已有经验的描述或内容，避免重复创建节点。",
        parameters: Type.Object({
          name: Type.String({ description: "要更新的节点名称（必须精确匹配已有节点；名称会被标准化：全小写、空格/下划线转连字符）" }),
          description: Type.Optional(
            Type.String({ description: "新的一句话说明（one-line summary）。不传则保留原值" }),
          ),
          content: Type.Optional(
            Type.String({ description: "新的知识内容（纯文本）。不传则保留原值" }),
          ),
        }),
        async execute(
          _toolCallId: string,
          p: { name: string; description?: string; content?: string },
        ) {
          if (p.description === undefined && p.content === undefined) {
            throw new Error(
              "[graph-memory] gm_update 至少需要提供 description 或 content 中的一个",
            );
          }
          const updated = updateNode(db, p.name, {
            description: p.description,
            content: p.content,
          });
          if (!updated) {
            throw new Error(
              `[graph-memory] 未找到名称为 "${p.name}" 的节点。` +
              `请检查节点名称是否精确（名称标准化规则：全小写、空格/下划线转连字符、移除非字母数字字符），` +
              `或使用 gm_record 创建新节点，也可用 gm_search 搜索已有节点。`,
            );
          }
          recaller.syncEmbed(updated).catch(() => {});
          const changes: string[] = [];
          if (p.description !== undefined) changes.push(`description="${updated.description}"`);
          if (p.content !== undefined) changes.push(`content (${updated.content.length} chars)`);
          return {
            content: [{
              type: "text",
              text: `已更新：${updated.name} (${updated.type})\n变更：${changes.join("，")}`,
            }],
            details: {
              name: updated.name,
              type: updated.type,
              description: updated.description,
              contentLength: updated.content.length,
            },
          };
        },
      }),
      { name: "gm_update" },
    );

    api.registerTool(
      (_ctx: any) => ({
        name: "gm_stats",
        label: "Graph Memory Stats",
        description: "查看知识图谱的统计信息：节点数、边数、社区数、PageRank Top 节点。",
        parameters: Type.Object({}),
        async execute(_toolCallId: string, _params: any) {
          const stats = getStats(db);
          const topPr = (db.prepare(
            "SELECT name, type, pagerank FROM gm_nodes WHERE status='active' ORDER BY pagerank DESC LIMIT 5"
          ).all() as any[]);

          const text = [
            `知识图谱统计`,
            `轮次摘要：${stats.turnMemories} 条`,
            `导航：${stats.navigationTerms} 个词项，${stats.navigationTriples} 条三元组，${stats.navigationCommunities} 个社区`,
            `节点：${stats.totalNodes} 个 (${Object.entries(stats.byType).map(([t, c]) => `${t}: ${c}`).join(", ")})`,
            `边：${stats.totalEdges} 条 (${Object.entries(stats.byEdgeType).map(([t, c]) => `${t}: ${c}`).join(", ")})`,
            `社区：${stats.communities} 个`,
            `PageRank Top 5：`,
            ...topPr.map((n, i) => `  ${i + 1}. ${n.name} (${n.type}, pr=${n.pagerank.toFixed(4)})`),
          ].join("\n");
          return {
            content: [{ type: "text", text }],
            details: stats,
          };
        },
      }),
      { name: "gm_stats" },
    );

    api.registerTool(
      (_ctx: any) => ({
        name: "gm_maintain",
        label: "Graph Memory Maintenance",
        description: "手动触发图维护：运行 PageRank 重算和社区检测。通常 session_end 时自动运行，这个工具用于手动触发。",
        parameters: Type.Object({}),
        async execute(_toolCallId: string, _params: any) {
          const result = await runMaintenance(db, cfg);
          const text = [
            `图维护完成（${result.durationMs}ms）`,
            `社区：${result.community.count + result.navigationCommunity.count} 个`,
            `PageRank Top 5：`,
            ...result.pagerank.topK.slice(0, 5).map((n, i) =>
              `  ${i + 1}. ${n.name} (${n.score.toFixed(4)})`),
          ].join("\n");
          return {
            content: [{ type: "text", text }],
            details: {
              durationMs: result.durationMs,
              communities: result.community.count + result.navigationCommunity.count,
            },
          };
        },
      }),
      { name: "gm_maintain" },
    );

    api.logger.info(
      `[graph-memory] ready | db=${cfg.dbPath} | provider=${configuredLlmBaseURL ? "custom" : provider} | model=${effectiveModel || "(none)"}`,
    );
  },
};

// ─── 取最近 N 轮用户交互（保留多步任务上下文） ──────────────

/**
 * 提取 assistant 消息中的纯文本内容，去掉 tool_use/thinking 等 schema
 */
function extractAssistantText(msg: any): string {
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .filter((b: any) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n")
    .trim();
}

/**
 * 提取 user 消息的纯文本内容
 * 去掉 OpenClaw 包装的 metadata（Sender JSON block、命令前缀、时间戳等）
 */
function extractUserText(msg: any): string {
  let raw: string;
  if (typeof msg.content === "string") {
    raw = msg.content;
  } else if (!Array.isArray(msg.content)) {
    raw = String(msg.content ?? "");
  } else {
    raw = msg.content
      .filter((b: any) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
  }

  // 去掉 OpenClaw metadata: "Sender (untrusted metadata):\n```json\n{...}\n```\n实际内容"
  // 策略：找最后一个 ``` 闭合后的内容，如果没有 ``` 就用 cleanPrompt 兜底
  const fenceEnd = raw.lastIndexOf("```");
  if (fenceEnd >= 0 && raw.includes("Sender")) {
    raw = raw.slice(fenceEnd + 3).trim();
  }

  // 兜底：去掉命令前缀、时间戳标记等
  raw = raw.replace(/^\/\w+\s+/, "").trim();
  raw = raw.replace(/^\[[\w\s\-:]+\]\s*/, "").trim();

  return raw;
}

/**
 * The extraction source is a completed conversational turn, not an agent
 * transcript. Keep only the user's text and the final visible assistant text.
 */
function projectCompletedTurnPairs(messages: any[]): any[] {
  const question = messages.find(message => message?.role === "user");
  const answer = [...messages].reverse().find(message => message?.role === "assistant");
  if (!question || !answer) return [];
  const questionText = extractUserText(question);
  const answerText = extractAssistantText(answer);
  if (!questionText || !answerText) return [];
  return [
    { ...question, content: questionText },
    { ...answer, content: answerText },
  ];
}

function projectRecentTurns(
  messages: any[],
  freshTurnCount: number,
): { messages: any[]; dropped: number } {
  if (!messages.length) {
    return { messages: [], dropped: 0 };
  }

  // Find the configured recent user turns. The host configuration, rather
  // than a hidden literal, owns the retention policy.
  const userIndices: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userIndices.push(i);
      if (userIndices.length >= freshTurnCount) break;
    }
  }
  if (!userIndices.length) {
    return { messages: [], dropped: messages.length };
  }

  // A turn's durable context surface is exactly the user question and the
  // final visible assistant answer. Tool payloads and chain-of-thought are
  // not re-injected or truncated; retained facts are available through recall.
  const selectedUsers = userIndices.reverse();
  const kept: any[] = [];
  for (let turn = 0; turn < selectedUsers.length; turn++) {
    const start = selectedUsers[turn];
    const end = selectedUsers[turn + 1] ?? messages.length;
    const question = extractUserText(messages[start]);
    if (question) kept.push({ role: "user", content: question });

    for (let i = end - 1; i > start; i--) {
      if (messages[i]?.role !== "assistant") continue;
      const answer = extractAssistantText(messages[i]);
      if (answer) {
        kept.push({ role: "assistant", content: answer });
        break;
      }
    }
  }
  const dropped = messages.length - kept.length;

  return { messages: kept, dropped };
}

export default graphMemoryPlugin;
