/**
 * graph-memory-pro — 查询向量 LRU 缓存
 *
 * recall 的 query embedding 是每次召回的固定开销（低成本但高频）：
 * 同会话内重复/回退的相同查询（before_agent_start ↔ assemble ↔ gm_search）
 * 直接复用向量，省一次 embedding API 调用。
 *
 * 注意：db 模式向量不走缓存（节点文本入库前必算，且 MiniMax 的 db/query
 * 走不同模型，向量不可互换）。embedding 端点/模型切换时调用方应 clear()。
 */

export class QueryVecCache {
  private map = new Map<string, number[]>();

  constructor(private readonly capacity = 64) {}

  get(key: string): number[] | undefined {
    const hit = this.map.get(key);
    if (hit === undefined) return undefined;
    // LRU 触碰：删掉重插，移到最新端
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  set(key: string, vec: number[]): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.capacity) {
      // Map 迭代序 = 插入序，最旧的是第一个 key
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, vec);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
