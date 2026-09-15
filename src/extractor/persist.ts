/**
 * graph-memory-pro — 提取结果持久化（单一来源）
 *
 * "upsertNode → 批量向量同步 → 解析端点 → upsertEdge" 这段持久化体此前在
 * index.ts（per-turn 提取 / compact 攒批提取）与 cli-extract.ts（CLI 回填）
 * 逐字复制三份，且已发生漂移（CLI await 了 syncEmbedBatch，运行时是
 * fire-and-forget）。收敛于此：改边解析/嵌入策略只需改这一处。
 */

import type { Driver } from "neo4j-driver";
import type { ExtractionResult, GmNode } from "../types.ts";
import { upsertNode, upsertEdge, findByName } from "../store/store.ts";
import type { Recaller } from "../recaller/recall.ts";

export interface PersistExtractionOptions {
  sessionId: string;
  /**
   * true = 等待批量向量同步完成再返回（CLI 路径：driver 将在 finally 里
   * closeDriver，不等待会让在途 embedding 请求撞上已关闭的 driver 且错误
   * 被吞——markExtracted 已执行，向量丢失不可自愈）；false = fire-and-forget
   * （运行时路径：不让 embedding 延迟拖住回合）。
   */
  awaitEmbedSync?: boolean;
  /** 每个成功 upsert 的节点回调（CLI 统计 nodesCreated 用）。 */
  onNodeUpserted?: (node: GmNode) => void;
}

export interface PersistExtractionOutcome {
  /** 实际 upsert 的节点 */
  nodes: GmNode[];
  /** 成功建立的边数（两端可解析且方向合法；upsertEdge 内部仍会按库中真实端点复核方向） */
  edges: number;
  /**
   * 命中已有节点的 upsert 数（isNew=false）。index.ts 把它按会话累加为
   * finalize 阶梯的第二触发条件——纠错型 invalidations 只有 finalize 能产出，
   * 而纠错常发生在小会话/无 EVENT 会话（shouldRunFinalize 的双门会漏掉）。
   */
  updatedExisting: number;
}

/**
 * 将一次 ExtractionResult 落库：upsert 全部节点 → 启动批量向量同步
 * （awaitEmbedSync 决定是否等待）→ 逐条解析并 upsert 边。
 * 边端点优先查本次 upsert 得到的 name→id 索引（零往返；键是规范化名，LLM
 * 原文未必规范化，未命中必须回源 findByName——它做 normalizeName）。
 * 不负责 markExtracted —— 各调用方的 upToTurn/producedKnowledge 语义不同。
 */
export async function persistExtractionResult(
  driver: Driver,
  recaller: Pick<Recaller, "syncEmbedBatch">,
  result: ExtractionResult,
  opts: PersistExtractionOptions,
): Promise<PersistExtractionOutcome> {
  const nameToId = new Map<string, string>();
  const upserted: GmNode[] = [];
  let updatedExisting = 0;
  for (const nc of result.nodes) {
    const { node, isNew } = await upsertNode(driver, {
      type: nc.type, name: nc.name,
      description: nc.description, content: nc.content,
    }, opts.sessionId);
    nameToId.set(node.name, node.id);
    upserted.push(node);
    if (!isNew) updatedExisting += 1;
    opts.onNodeUpserted?.(node);
  }

  // 批量向量同步：N 个节点一次 embedBatch + 一次 UNWIND 批读写（替代逐节点 N 次单发）
  const embedSync = recaller.syncEmbedBatch(upserted).catch(() => {});
  if (opts.awaitEmbedSync) await embedSync;
  else void embedSync;

  let edgeCount = 0;
  for (const ec of result.edges) {
    const fromId = nameToId.get(ec.from) ?? (await findByName(driver, ec.from))?.id;
    const toId = nameToId.get(ec.to) ?? (await findByName(driver, ec.to))?.id;
    if (fromId && toId) {
      await upsertEdge(driver, {
        fromId, toId, type: ec.type,
        instruction: ec.instruction, condition: ec.condition, sessionId: opts.sessionId,
      });
      edgeCount += 1;
    }
  }

  return { nodes: upserted, edges: edgeCount, updatedExisting };
}
