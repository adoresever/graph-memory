/**
 * graph-memory
 *
 * By: adoresever
 * Email: Wywelljob@gmail.com
 */

/**
 * 向量余弦去重 — 发现并合并语义重复的节点
 *
 * 原理：两个节点的 embedding 余弦相似度 > threshold → 视为重复
 *
 * 例子：
 *   - "conda-env-create" 和 "conda-create-environment" → 同一个技能
 *   - "importerror-libgl1" 和 "libgl-missing-error" → 同一个事件
 *
 * 合并策略：
 *   - 保留 validatedCount 更高的节点
 *   - 合并 sourceSessions
 *   - 迁移边（from/to 都改指向保留节点）
 *   - 被合并节点标记 deprecated
 *
 * 复杂度：O(n²) 比较，n = 有向量的节点数。几千节点 < 50ms。
 */

import { DatabaseSync, type DatabaseSyncInstance } from "@photostructure/sqlite";
import type { GmConfig, GmNode } from "../types.js";
import { findById, mergeNodes, getAllVectors } from "../store/store.js";

export interface DuplicatePair {
  nodeA: string;
  nodeB: string;
  nameA: string;
  nameB: string;
  similarity: number;
}

export interface DedupResult {
  /** 发现的重复对 */
  pairs: DuplicatePair[];
  /** 实际合并的数量 */
  merged: number;
}

/**
 * 余弦相似度
 */
function cosineSim(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-9);
}

/**
 * 检测重复节点对
 *
 * 需要 embedding 才能工作，没有向量的节点会被跳过。
 * FTS5 名称完全匹配由 store.upsertNode 已处理，这里处理语义重复。
 */
export function detectDuplicates(db: DatabaseSyncInstance, cfg: GmConfig): DuplicatePair[] {
  const vectors = getAllVectors(db);
  if (vectors.length < 2) return [];

  const threshold = cfg.dedupThreshold;
  const pairs: DuplicatePair[] = [];

  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      const sim = cosineSim(vectors[i].embedding, vectors[j].embedding);
      if (sim >= threshold) {
        const nodeA = findById(db, vectors[i].nodeId);
        const nodeB = findById(db, vectors[j].nodeId);
        if (nodeA && nodeB) {
          pairs.push({
            nodeA: nodeA.id,
            nodeB: nodeB.id,
            nameA: nodeA.name,
            nameB: nodeB.name,
            similarity: sim,
          });
        }
      }
    }
  }

  return pairs.sort((a, b) => b.similarity - a.similarity);
}

/**
 * 检测并自动合并重复节点
 *
 * 合并规则：
 *   - 同类型才合并（SKILL+SKILL，EVENT+EVENT）
 *   - 保留 validatedCount 更高的
 *   - validatedCount 相同时保留更新时间更近的
 */
export function dedup(db: DatabaseSyncInstance, cfg: GmConfig): DedupResult {
  const pairs = detectDuplicates(db, cfg);
  let merged = 0;

  // 已经被合并过的节点不再参与合并
  const consumed = new Set<string>();

  for (const pair of pairs) {
    if (consumed.has(pair.nodeA) || consumed.has(pair.nodeB)) continue;

    const a = findById(db, pair.nodeA);
    const b = findById(db, pair.nodeB);
    if (!a || !b) continue;

    // 只合并同类型
    if (a.type !== b.type) continue;

    // 决定保留哪个
    let keepId: string, mergeId: string;
    if (a.validatedCount > b.validatedCount) {
      keepId = a.id; mergeId = b.id;
    } else if (b.validatedCount > a.validatedCount) {
      keepId = b.id; mergeId = a.id;
    } else {
      // 相同则保留更新的
      keepId = a.updatedAt >= b.updatedAt ? a.id : b.id;
      mergeId = keepId === a.id ? b.id : a.id;
    }

    mergeNodes(db, keepId, mergeId);
    consumed.add(mergeId);
    merged++;
  }

  return { pairs, merged };
}