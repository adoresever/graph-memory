/**
 * graph-memory-pro — Neo4j 版知识图谱记忆引擎
 *
 * 基于 graph-memory v1.2.1 改造
 * 存储：Neo4j 5.24.2 + GDS 2.12.0
 * 可视化：Neovis 3D（ClawX 内嵌）
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { getDriver, initSchema, getSession, closeDriver } from "./src/store/db.ts";
import {
  saveMessage, getUnextracted,
  markExtracted, isTurnExtracted,
  upsertNode, upsertEdge, findByName, updateNode,
  getBySession, edgesFrom, edgesTo,
  deprecate, getStats,
} from "./src/store/store.ts";
import { createCompleteFn } from "./src/engine/llm.ts";
import { createEmbedFn } from "./src/engine/embed.ts";
import { Recaller } from "./src/recaller/recall.ts";
import { Extractor } from "./src/extractor/extract.ts";
import { assembleContext } from "./src/format/assemble.ts";
import { sanitizeToolUseResultPairing } from "./src/format/transcript-repair.ts";
import { runMaintenance } from "./src/graph/maintenance.ts";
import { DEFAULT_CONFIG, type GmConfig } from "./src/types.ts";
import { registerCrudRoutes } from "./src/routes/crud.ts";

// ─── 从 OpenClaw config 读 provider/model ────────────────────

export function readProviderModel(apiConfig: unknown): { provider: string; model: string } {
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
    if (provider?.trim() && model) return { provider: provider.trim(), model };
  }
  if (raw) {
    return { provider: "anthropic", model: raw };
  }
  return { provider: "", model: "" };
}

// ─── 清洗 OpenClaw metadata 包装 ─────────────────────────────

export function cleanPrompt(raw: string): string {
  let prompt = raw.trim();
  if (prompt.includes("Sender (untrusted metadata)")) {
    const jsonStart = prompt.indexOf("```json");
    if (jsonStart >= 0) {
      const jsonEnd = prompt.indexOf("```", jsonStart + 7);
      if (jsonEnd >= 0) prompt = prompt.slice(jsonEnd + 3).trim();
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

// ─── 规范化消息 content，防 OpenClaw content.filter() 崩溃 ────

export function normalizeMessageContent(messages: any[]): any[] {
  return messages.map((msg: any) => {
    if (!msg || typeof msg !== "object") return msg;
    const c = msg.content;
    // 数组 → 修复畸形 block（如 { type: "text" } 缺 text 属性）
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

// ─── assemble 消息裁剪：保留最近 N 轮，旧轮只留文本 ──────────

const KEEP_TURNS = 5;

function estimateMsgTokens(msg: any): number {
  const text = typeof msg.content === "string"
    ? msg.content
    : JSON.stringify(msg.content ?? "");
  return Math.ceil(text.length / 3);
}

export function extractAssistantText(msg: any): string {
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .filter((b: any) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n")
    .trim();
}

export function extractUserText(msg: any): string {
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
  // 去掉 OpenClaw metadata（Sender JSON block、命令前缀、时间戳）
  const fenceEnd = raw.lastIndexOf("```");
  if (fenceEnd >= 0 && raw.includes("Sender")) {
    raw = raw.slice(fenceEnd + 3).trim();
  }
  raw = raw.replace(/^\/\w+\s+/, "").trim();
  raw = raw.replace(/^\[[\w\s\-:]+\]\s*/, "").trim();
  return raw;
}

export function sliceLastTurn(
  messages: any[],
): { messages: any[]; tokens: number; dropped: number } {
  if (!messages.length) {
    return { messages: [], tokens: 0, dropped: 0 };
  }

  // 找到最近 N 个 user 消息的位置
  const userIndices: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userIndices.push(i);
      if (userIndices.length >= KEEP_TURNS) break;
    }
  }
  if (!userIndices.length) {
    return { messages: [], tokens: 0, dropped: messages.length };
  }

  const lastTurnUserIdx = userIndices[0];

  // 最后 1 轮：完整保留（含 toolResult，Agent 需要最新执行结果），但截断超长 tool_result
  let lastTurnMsgs = messages.slice(lastTurnUserIdx);
  const TOOL_MAX = 6000;
  lastTurnMsgs = lastTurnMsgs.map((msg: any) => {
    if (msg.role !== "tool" && msg.role !== "toolResult") return msg;
    if (typeof msg.content !== "string") return msg;
    if (msg.content.length <= TOOL_MAX) return msg;
    const head = Math.floor(TOOL_MAX * 0.6);
    const tail = Math.floor(TOOL_MAX * 0.3);
    return { ...msg, content: msg.content.slice(0, head) + `\n...[truncated ${msg.content.length - head - tail} chars]...\n` + msg.content.slice(-tail) };
  });

  // 前 N-1 轮：只保留 user 输入 + assistant 文本（去掉 tool schema）
  const prevTurnMsgs: any[] = [];
  if (userIndices.length > 1) {
    const earliestIdx = userIndices[userIndices.length - 1];
    for (let i = earliestIdx; i < lastTurnUserIdx; i++) {
      const msg = messages[i];
      if (!msg) continue;
      if (msg.role === "user") {
        const text = extractUserText(msg);
        if (text) prevTurnMsgs.push({ role: "user", content: text });
      } else if (msg.role === "assistant") {
        const text = extractAssistantText(msg);
        if (text) prevTurnMsgs.push({ role: "assistant", content: text });
      }
    }
  }

  // 合并：前 N-1 轮摘要 + 最后 1 轮完整
  const kept = [...prevTurnMsgs, ...lastTurnMsgs];
  const dropped = messages.length - kept.length;
  let tokens = 0;
  for (const msg of kept) tokens += estimateMsgTokens(msg);
  return { messages: kept, tokens, dropped };
}

// ─── 插件对象 ─────────────────────────────────────────────────

const graphMemoryProPlugin = {
  id: "graph-memory-pro",
  name: "Graph Memory Pro",
  description:
    "Neo4j 知识图谱记忆引擎：三元组存储 + GDS 图算法 + 向量索引 + Neovis 3D 可视化",

  register(api: OpenClawPluginApi) {
    // ── 读配置 ──────────────────────────────────────────────
    const raw =
      api.pluginConfig && typeof api.pluginConfig === "object"
        ? (api.pluginConfig as any)
        : {};
    const cfg: GmConfig = { ...DEFAULT_CONFIG, ...raw };
    if (raw.neo4j) cfg.neo4j = { ...DEFAULT_CONFIG.neo4j, ...raw.neo4j };

    const { provider, model } = readProviderModel(api.config);

    const effectiveModel = cfg.llm?.model ?? model;
    if (!effectiveModel) {
      api.logger.warn(
        "[graph-memory-pro] No LLM model configured. Set agents.defaults.model in openclaw.json " +
        "or config.llm.model in graph-memory plugin config — extraction and community summaries will fail.",
      );
    }

    // ── 初始化 Neo4j ────────────────────────────────────────
    const driver = getDriver(cfg.neo4j);

    // Schema 初始化（异步，不阻塞启动）
    initSchema(driver, cfg.embedding)
      .then(() => api.logger.info("[graph-memory-pro] Neo4j schema initialized"))
      .catch(err => api.logger.error(`[graph-memory-pro] schema init failed: ${err}`));

    const anthropicApiKey = cfg.llm?.apiKey && !cfg.llm.baseURL
      ? cfg.llm.apiKey
      : undefined;
    const llm = createCompleteFn(provider, model, cfg.llm, anthropicApiKey);
    const recaller = new Recaller(driver, cfg);
    const extractor = new Extractor(cfg, llm);

    // ── 初始化 embedding ────────────────────────────────────
    createEmbedFn(cfg.embedding)
      .then((fn) => {
        if (fn) {
          recaller.setEmbedFn(fn);
          api.logger.info("[graph-memory-pro] vector search ready");
        } else {
          api.logger.info("[graph-memory-pro] text search mode (配置 embedding 可启用语义搜索)");
        }
      })
      .catch(() => {
        api.logger.info("[graph-memory-pro] text search mode");
      });

    /**
     * 每轮结束后直接从原始消息提取知识图谱
     * 一轮 = 用户发一条消息 → agent 不管调了多少工具 → 最终回复用户
     */
    async function extractTurnKnowledge(sessionId: string, turnNum: number, rawMessages: any[]): Promise<void> {
      try {
        if (await isTurnExtracted(driver, sessionId, turnNum)) {
          api.logger.info(`[graph-memory-pro] turn ${turnNum}: already extracted (compact), skipping`);
          return;
        }
        const existing = (await getBySession(driver, sessionId)).map(n => n.name);
        const result = await extractor.extract({
          messages: rawMessages,
          existingNames: existing,
        });

        if (!result.nodes.length && !result.edges.length) {
          await markExtracted(driver, sessionId, turnNum);
          api.logger.info(`[graph-memory-pro] turn ${turnNum}: no knowledge extracted (marked extracted)`);
          return;
        }

        const nameToId = new Map<string, string>();
        for (const nc of result.nodes) {
          const { node } = await upsertNode(driver, {
            type: nc.type, name: nc.name,
            description: nc.description, content: nc.content,
          }, sessionId);
          nameToId.set(node.name, node.id);
          recaller.syncEmbed(node).catch(() => {});
        }

        for (const ec of result.edges) {
          const fromNode = await findByName(driver, ec.from);
          const toNode = await findByName(driver, ec.to);
          const fromId = nameToId.get(ec.from) ?? fromNode?.id;
          const toId = nameToId.get(ec.to) ?? toNode?.id;
          if (fromId && toId) {
            await upsertEdge(driver, {
              fromId, toId, type: ec.type,
              instruction: ec.instruction, condition: ec.condition, sessionId,
            });
          }
        }

        // 标记该轮消息已提取
        await markExtracted(driver, sessionId, turnNum);

        api.logger.info(`[graph-memory-pro] turn ${turnNum}: extracted ${result.nodes.length} nodes, ${result.edges.length} edges`);
      } catch (err) {
        api.logger.error(`[graph-memory-pro] turn ${turnNum} extract failed: ${err}`);
      }
    }

    // ── Session 运行时状态 ──────────────────────────────────
    const msgSeq = new Map<string, number>();
    const recalled = new Map<string, { nodes: any[]; edges: any[] }>();

    async function ingestMessage(sessionId: string, message: any): Promise<void> {
      const seq = (msgSeq.get(sessionId) ?? 0) + 1;
      msgSeq.set(sessionId, seq);
      await saveMessage(driver, sessionId, seq, message.role ?? "unknown", message);
    }

    // ── before_agent_start：召回 ────────────────────────────

    api.on("before_agent_start", async (event: any, ctx: any) => {
      try {
        const rawPrompt = typeof event?.prompt === "string" ? event.prompt : "";
        const prompt = cleanPrompt(rawPrompt);
        if (!prompt) return;
        if (prompt.includes("/new or /reset") || prompt.includes("new session was started")) return;

        api.logger.info(`[graph-memory-pro] recall query: "${prompt.slice(0, 80)}"`);

        const res = await recaller.recall(prompt);
        if (res.nodes.length) {
          if (ctx?.sessionId) recalled.set(ctx.sessionId, res);
          if (ctx?.sessionKey && ctx.sessionKey !== ctx?.sessionId) {
            recalled.set(ctx.sessionKey, res);
          }
          api.logger.info(`[graph-memory-pro] recalled ${res.nodes.length} nodes, ${res.edges.length} edges`);
        }
      } catch (err) {
        api.logger.warn(`[graph-memory-pro] recall failed: ${err}`);
      }
    });

    // ── ContextEngine ────────────────────────────────────────

    const engine = {
      info: {
        id: "graph-memory-pro",
        name: "Graph Memory Pro",
        ownsCompaction: true,
      },

      async bootstrap({ sessionId }: { sessionId: string }) {
        return { bootstrapped: true };
      },

      async ingest({ sessionId, message, isHeartbeat }: { sessionId: string; message: any; isHeartbeat?: boolean }) {
        if (isHeartbeat) return { ingested: false };
        await ingestMessage(sessionId, message);
        return { ingested: true };
      },

      async assemble({ sessionId, messages, tokenBudget, prompt }: {
        sessionId: string; messages: any[]; tokenBudget?: number; prompt?: string;
      }) {
        const budget = tokenBudget ?? 128_000;

        const activeNodes = await getBySession(driver, sessionId);
        const activeEdges: any[] = [];
        for (const n of activeNodes) {
          activeEdges.push(...await edgesFrom(driver, n.id));
          activeEdges.push(...await edgesTo(driver, n.id));
        }

        // prompt-aware recall：优先用当前 prompt 做新鲜召回，回退到 before_agent_start 缓存
        let rec = recalled.get(sessionId) ?? { nodes: [], edges: [] };
        if (prompt) {
          const cleaned = cleanPrompt(prompt);
          if (cleaned) {
            try {
              const freshRec = await recaller.recall(cleaned);
              if (freshRec.nodes.length) {
                rec = freshRec;
                recalled.set(sessionId, freshRec);
              }
            } catch (err) {
              api.logger.warn(`[graph-memory-pro] assemble recall failed: ${err}`);
            }
          }
        }
        const totalGmNodes = activeNodes.length + rec.nodes.length;

        if (totalGmNodes === 0) {
          return { messages: normalizeMessageContent(messages), estimatedTokens: 0 };
        }

        const { xml, systemPrompt, tokens: gmTokens } = await assembleContext(driver, {
          tokenBudget: budget,
          activeNodes,
          activeEdges,
          recalledNodes: rec.nodes,
          recalledEdges: rec.edges,
        });

        const lastTurn = sliceLastTurn(messages);
        const repaired = sanitizeToolUseResultPairing(lastTurn.messages);

        if (lastTurn.dropped > 0) {
          api.logger.info(
            `[graph-memory-pro] assemble: ${lastTurn.messages.length} msgs (~${lastTurn.tokens} tok), ` +
            `dropped ${lastTurn.dropped} older msgs, graph ~${gmTokens} tok`,
          );
        }

        let systemPromptAddition: string | undefined;
        if (xml) {
          systemPromptAddition = systemPrompt ? `${systemPrompt}\n\n${xml}` : xml;
        }

        return {
          messages: normalizeMessageContent(repaired),
          estimatedTokens: gmTokens + lastTurn.tokens,
          ...(systemPromptAddition ? { systemPromptAddition } : {}),
        };
      },

      async compact({ sessionId, currentTokenCount }: { sessionId: string; sessionFile: string; tokenBudget?: number; force?: boolean; currentTokenCount?: number }) {
        const msgs = await getUnextracted(driver, sessionId, cfg.compactTurnCount * 3);

        if (!msgs.length) return { ok: true, compacted: false, reason: "no messages" };

        try {
          const existing = (await getBySession(driver, sessionId)).map(n => n.name);
          const result = await extractor.extract({ messages: msgs, existingNames: existing });

          const nameToId = new Map<string, string>();
          for (const nc of result.nodes) {
            const { node } = await upsertNode(driver, {
              type: nc.type, name: nc.name,
              description: nc.description, content: nc.content,
            }, sessionId);
            nameToId.set(node.name, node.id);
            recaller.syncEmbed(node).catch(() => {});
          }

          for (const ec of result.edges) {
            const fromNode = await findByName(driver, ec.from);
            const toNode = await findByName(driver, ec.to);
            const fromId = nameToId.get(ec.from) ?? fromNode?.id;
            const toId = nameToId.get(ec.to) ?? toNode?.id;
            if (fromId && toId) {
              await upsertEdge(driver, {
                fromId, toId, type: ec.type,
                instruction: ec.instruction, condition: ec.condition, sessionId,
              });
            }
          }

          const maxTurn = Math.max(...msgs.map((m: any) => m.turn_index));
          await markExtracted(driver, sessionId, maxTurn);

          return {
            ok: true, compacted: true,
            result: {
              summary: `extracted ${result.nodes.length} nodes, ${result.edges.length} edges`,
              tokensBefore: currentTokenCount ?? 0,
            },
          };
        } catch (err) {
          api.logger.error(`[graph-memory-pro] compact failed: ${err}`);
          return { ok: false, compacted: false, reason: String(err) };
        }
      },

      async afterTurn({ sessionId, messages, prePromptMessageCount, isHeartbeat }: {
        sessionId: string; sessionFile: string; messages: any[];
        prePromptMessageCount: number; autoCompactionSummary?: string;
        isHeartbeat?: boolean; tokenBudget?: number;
      }) {
        if (isHeartbeat) return;

        const newMessages = messages.slice(prePromptMessageCount ?? 0);
        if (!newMessages.length) return;

        // 轮次计数
        const turnNum = (msgSeq.get(sessionId) ?? 0) + 1;
        msgSeq.set(sessionId, turnNum);

        // 整轮存为 1 条 GmMessage（溯源用）
        await saveMessage(driver, sessionId, turnNum, "turn", newMessages);

        api.logger.info(`[graph-memory-pro] afterTurn sid=${sessionId.slice(0, 8)} turn=${turnNum} rawMsgs=${newMessages.length}`);

        // 直接用原始消息提取知识图谱（异步，不阻塞）
        extractTurnKnowledge(sessionId, turnNum, newMessages).catch(err => {
          api.logger.error(`[graph-memory-pro] extract failed: ${err}`);
        });
      },

      async prepareSubagentSpawn({ parentSessionKey, childSessionKey }: { parentSessionKey: string; childSessionKey: string }) {
        const rec = recalled.get(parentSessionKey);
        if (rec) recalled.set(childSessionKey, rec);
        return { rollback: () => { recalled.delete(childSessionKey); } };
      },

      async onSubagentEnded({ childSessionKey }: { childSessionKey: string }) {
        recalled.delete(childSessionKey);
        msgSeq.delete(childSessionKey);
      },

      async dispose() {
        msgSeq.clear();
        recalled.clear();
        // 不关闭 Neo4j driver — 让连接池自己管理
        // closeDriver() 只在进程退出时由 Node.js 自动清理
      },
    };

    api.registerContextEngine("graph-memory-pro", () => engine);

    // ── session_end：finalize + 图维护 ──────────────────────

    api.on("session_end", async (event: any, ctx: any) => {
      const sid = ctx?.sessionKey ?? ctx?.sessionId ?? event?.sessionKey ?? event?.sessionId;
      if (!sid) return;

      try {
        const nodes = await getBySession(driver, sid);
        if (nodes.length) {
          // 获取图谱摘要
          const session = getSession(driver);
          let summary = "";
          try {
            const summaryResult = await session.run(`
              MATCH (n:Task|Skill|Event {status: 'active'})
              RETURN n.name AS name, n.type AS type, n.validatedCount AS vc, n.pagerank AS pr
              ORDER BY n.pagerank DESC LIMIT 20
            `);
            summary = summaryResult.records
              .map(r => `${r.get("type")}:${r.get("name")}(v${r.get("vc")},pr${(r.get("pr") ?? 0).toFixed?.(3) ?? "0"})`)
              .join(", ");
          } finally {
            await session.close();
          }

          const fin = await extractor.finalize({ sessionNodes: nodes, graphSummary: summary });

          for (const nc of fin.promotedSkills) {
            if (nc.name && nc.content) {
              await upsertNode(driver, {
                type: "SKILL", name: nc.name,
                description: nc.description ?? "", content: nc.content,
              }, sid);
            }
          }
          for (const ec of fin.newEdges) {
            const fromNode = await findByName(driver, ec.from);
            const toNode = await findByName(driver, ec.to);
            if (fromNode && toNode) {
              await upsertEdge(driver, {
                fromId: fromNode.id, toId: toNode.id, type: ec.type,
                instruction: ec.instruction, sessionId: sid,
              });
            }
          }
          for (const id of fin.invalidations) await deprecate(driver, id);
        }

        // 图维护
        const embedFn = (recaller as any).embed ?? undefined;
        const result = await runMaintenance(driver, cfg, llm, embedFn);
        api.logger.info(
          `[graph-memory-pro] maintenance: ${result.durationMs}ms, ` +
          `dedup=${result.dedup.merged}, communities=${result.community.count}, ` +
          `summaries=${result.communitySummaries}, ` +
          `top_pr=${result.pagerank.topK.slice(0, 3).map(n => `${n.name}(${n.score.toFixed(3)})`).join(",")}`,
        );
      } catch (err) {
        api.logger.error(`[graph-memory-pro] session_end error: ${err}`);
      } finally {
        msgSeq.delete(sid);
        recalled.delete(sid);
      }
    });

    // ── Agent Tools ─────────────────────────────────────────

    api.registerTool(
      (_ctx: any) => ({
        name: "gm_search",
        label: "Search Graph Memory",
        description: "搜索知识图谱中的相关经验、技能和解决方案。",
        parameters: Type.Object({
          query: Type.String({ description: "搜索关键词或问题描述" }),
        }),
        async execute(_toolCallId: string, params: { query: string }) {
          const res = await recaller.recall(params.query);
          if (!res.nodes.length) {
            return { content: [{ type: "text", text: "图谱中未找到相关记录。" }], details: { count: 0, query: params.query } };
          }
          const lines = res.nodes.map(n => `[${n.type}] ${n.name} (pr:${n.pagerank.toFixed(3)})\n${n.description}\n${n.content.slice(0, 400)}`);
          const edgeLines = res.edges.map(e => {
            const from = res.nodes.find(n => n.id === e.fromId)?.name ?? e.fromId;
            const to = res.nodes.find(n => n.id === e.toId)?.name ?? e.toId;
            return `  ${from} --[${e.type}]--> ${to}: ${e.instruction}`;
          });
          const text = [`找到 ${res.nodes.length} 个节点：\n`, ...lines, ...(edgeLines.length ? ["\n关系：", ...edgeLines] : [])].join("\n\n");
          return { content: [{ type: "text", text }], details: { count: res.nodes.length, query: params.query } };
        },
      }),
      { name: "gm_search" },
    );

    api.registerTool(
      (ctx: any) => ({
        name: "gm_record",
        label: "Record to Graph Memory",
        description: "手动记录经验到知识图谱。",
        parameters: Type.Object({
          name: Type.String({ description: "节点名称" }),
          type: Type.String({ description: "TASK、SKILL 或 EVENT" }),
          description: Type.String({ description: "一句话说明" }),
          content: Type.String({ description: "纯文本知识内容" }),
          relatedSkill: Type.Optional(Type.String({ description: "关联的已有技能名" })),
        }),
        async execute(_toolCallId: string, p: any) {
          const sid = ctx?.sessionKey ?? ctx?.sessionId ?? "manual";
          const { node } = await upsertNode(driver, { type: p.type, name: p.name, description: p.description, content: p.content }, sid);
          if (p.relatedSkill) {
            const rel = await findByName(driver, p.relatedSkill);
            if (rel) {
              await upsertEdge(driver, { fromId: node.id, toId: rel.id, type: "SOLVED_BY", instruction: `关联 ${p.relatedSkill}`, sessionId: sid });
            }
          }
          recaller.syncEmbed(node).catch(() => {});
          return { content: [{ type: "text", text: `✅ 已记录：${node.name} (${node.type})` }], details: { name: node.name, type: node.type } };
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
              "[graph-memory-pro] gm_update 至少需要提供 description 或 content 中的一个",
            );
          }
          const updated = await updateNode(driver, p.name, {
            description: p.description,
            content: p.content,
          });
          if (!updated) {
            throw new Error(
              `[graph-memory-pro] 未找到名称为 "${p.name}" 的节点。` +
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
        description: "查看知识图谱统计信息。",
        parameters: Type.Object({}),
        async execute() {
          const stats = await getStats(driver);
          const session = getSession(driver);
          let topPr: any[] = [];
          try {
            const r = await session.run("MATCH (n:Task|Skill|Event {status:'active'}) RETURN n.name AS name, n.type AS type, n.pagerank AS pr ORDER BY n.pagerank DESC LIMIT 5");
            topPr = r.records.map(rec => ({ name: rec.get("name"), type: rec.get("type"), pr: rec.get("pr") ?? 0 }));
          } finally {
            await session.close();
          }
          const text = [
            `📊 知识图谱统计（Neo4j）`,
            `节点：${stats.totalNodes} 个 (${Object.entries(stats.byType).map(([t, c]) => `${t}: ${c}`).join(", ")})`,
            `边：${stats.totalEdges} 条 (${Object.entries(stats.byEdgeType).map(([t, c]) => `${t}: ${c}`).join(", ")})`,
            `社区：${stats.communities} 个`,
            `PageRank Top 5：`,
            ...topPr.map((n, i) => `  ${i + 1}. ${n.name} (${n.type}, pr=${(typeof n.pr === "number" ? n.pr : 0).toFixed(4)})`),
          ].join("\n");
          return { content: [{ type: "text", text }], details: stats };
        },
      }),
      { name: "gm_stats" },
    );

    api.registerTool(
      (_ctx: any) => ({
        name: "gm_maintain",
        label: "Graph Memory Maintenance",
        description: "手动触发图维护：去重、PageRank、社区检测。",
        parameters: Type.Object({}),
        async execute() {
          const embedFn = (recaller as any).embed ?? undefined;
          const result = await runMaintenance(driver, cfg, llm, embedFn);
          const text = [
            `🔧 图维护完成（${result.durationMs}ms）`,
            `去重：${result.dedup.pairs.length} 对相似，合并 ${result.dedup.merged} 对`,
            ...(result.dedup.pairs.length > 0
              ? result.dedup.pairs.slice(0, 5).map(p => `  "${p.nameA}" ≈ "${p.nameB}" (${(p.similarity * 100).toFixed(1)}%)`)
              : []),
            `社区：${result.community.count} 个`,
            `社区描述：${result.communitySummaries} 个`,
            `PageRank Top 5：`,
            ...result.pagerank.topK.slice(0, 5).map((n, i) => `  ${i + 1}. ${n.name} (${n.score.toFixed(4)})`),
          ].join("\n");
          return { content: [{ type: "text", text }], details: { durationMs: result.durationMs, dedupMerged: result.dedup.merged, communities: result.community.count } };
        },
      }),
      { name: "gm_maintain" },
    );

    // ── CRUD REST 路由（给 ClawX 前端用） ─────────────────
    registerCrudRoutes(api, driver, recaller);

    // ── Neovis 配置接口（给 ClawX 前端用） ──────────────────

    api.registerHttpRoute({
      path: "/graph-memory-pro/neo4j-config",
      auth: "gateway",
      match: "exact",
      handler: async (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          bolt: cfg.neo4j.uri,
          user: cfg.neo4j.user,
          password: cfg.neo4j.password,
          initialCypher: "MATCH (n:Task|Skill|Event {status:'active'})-[r]->(m:Task|Skill|Event {status:'active'}) RETURN n, r, m LIMIT 200",
        }));
        return true;
      },
    });

    api.logger.info(
      `[graph-memory-pro] ready | neo4j=${cfg.neo4j.uri} | provider=${provider} | model=${effectiveModel || "(none)"}`,
    );
  },
};

export default graphMemoryProPlugin;
