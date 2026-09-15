/**
 * graph-memory-pro — Neo4j 熔断门控（circuit breaker）
 *
 * 解决的问题：Neo4j 掉线时，每次 ingest / assemble / recall 都要吃满
 * driver 的重试与连接获取超时（最坏数十秒），对话每轮都被拖住，
 * 体验上等同于"卡死"。
 *
 * 语义：
 * - closed（正常）：isAvailable() === true，所有操作放行。
 * - open（跳闸）：连续失败 >= failureThreshold 次后进入；冷却期内
 *   isAvailable() === false，调用方应立即降级（跳过图谱、缓冲消息），
 *   而不是等 driver 超时。
 * - half-open（半开探测）：冷却期结束后 isAvailable() 恢复 true，
 *   下一个真实操作充当探测 —— 成功则复位 closed，失败则重新计时冷却。
 *
 * 注意：失败计数只应从"纯 Neo4j 调用点"记录（saveMessage / getBySession
 * 等）。混合了 LLM / embedding 的调用点（recall、compact）不要记录，
 * 否则 LLM 超时会误跳闸。
 */

export class Neo4jGate {
  private consecutiveFailures = 0;
  private open = false;
  private openedAt = 0;

  constructor(
    /** 连续失败多少次后跳闸 */
    private readonly failureThreshold: number = 2,
    /** 跳闸后的冷却时长（ms），到期进入半开 */
    private readonly cooldownMs: number = 120_000,
  ) {}

  /** 操作成功：复位计数并闭合熔断。 */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.open = false;
  }

  /**
   * 操作失败：累计计数；达到阈值跳闸。
   * 已处于 open 时再次失败（半开探测失败 / 在途请求迟到失败）会
   * 重置冷却计时 —— 但被门控的调用方在 open 期间不会发起操作，
   * 所以不会出现"永远无法恢复"的抖动。
   */
  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (!this.open && this.consecutiveFailures >= this.failureThreshold) {
      this.open = true;
    }
    if (this.open) {
      this.openedAt = Date.now();
    }
  }

  /** 当前是否放行操作（closed 或 冷却到期的 half-open）。 */
  isAvailable(): boolean {
    if (!this.open) return true;
    return Date.now() - this.openedAt >= this.cooldownMs;
  }
}
