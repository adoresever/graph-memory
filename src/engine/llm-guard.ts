/**
 * graph-memory-pro — LLM 失败冷却守卫
 *
 * 与 Neo4jGate（DB 熔断）对偶：保护 LLM 依赖。
 * 仅对"持久性配置错误"触发冷却 —— 401/403/404（凭证失效、无权限、模型名/端点错误），
 * 这类错误不会自愈，逐轮重试只会浪费每次完整的请求 + 超时等待。
 *
 * 不触发的情况：
 *   - 429/5xx：瞬时故障，fetchRetry 已内部重试，冷却反而放大抖动
 *   - 400/422：可能只是单条坏 prompt（超长/格式问题），不能殃及后续正常调用
 *   - 无状态码的错误（超时、空返回、缺配置）：交给各自的正常失败路径
 *
 * 例外：OAuth token 端点的 400 = invalid_grant（refresh token 被吊销/过期），
 * 与聊天端点的 400（可能只是单条坏 prompt）语义不同 —— 属于持久性凭证故障，
 * 同样触发冷却；恢复路径是重新 auth login（llm.ts 会按会话文件 mtime 自动解除）。
 */

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 529]);
const PAUSING_STATUSES = new Set([401, 403, 404]);
const OAUTH_REFRESH_PAUSING_STATUSES = new Set([400, 401, 403]);

/**
 * 从错误消息中提取 HTTP 状态码。
 * 覆盖三条 provider 路径的报错格式：
 *   "[graph-memory] LLM API 401: …"        （openai 兼容）
 *   "[graph-memory] Anthropic API 403: …"  （anthropic）
 *   "[graph-memory] OAuth LLM API 401: …"  （oauth，含 "LLM API 401" 子串）
 */
export function extractLlmStatus(error: unknown): number | null {
  const text = String(error ?? "");
  const match = text.match(/\b(?:LLM|Anthropic) API (\d{3})\b/);
  if (!match) return null;
  return Number(match[1]);
}

/**
 * 识别 oauth.ts refreshOAuthSession 的报错格式："OAuth refresh failed (400): …"。
 * 独立于 extractLlmStatus —— token 端点与聊天端点对同一状态码的语义不同。
 */
export function extractOAuthRefreshStatus(error: unknown): number | null {
  const match = String(error ?? "").match(/\bOAuth refresh failed \((\d{3})\)/);
  if (!match) return null;
  return Number(match[1]);
}

export class LlmFailureGuard {
  private pausedUntil = 0;

  constructor(
    private readonly cooldownMs = 10 * 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  canRun(): boolean {
    return this.now() >= this.pausedUntil;
  }

  remainingMs(): number {
    return Math.max(0, this.pausedUntil - this.now());
  }

  /** 成功调用后清除冷却，下一次失败重新计时。 */
  reset(): void {
    this.pausedUntil = 0;
  }

  /**
   * 按错误类型决定是否触发冷却。
   * 返回是否触发（调用方仅用于日志/测试；冷却本身幂等，重复触发取更晚到期时间）。
   */
  tripIfNeeded(error: unknown): boolean {
    const refreshStatus = extractOAuthRefreshStatus(error);
    if (refreshStatus != null) {
      if (!OAUTH_REFRESH_PAUSING_STATUSES.has(refreshStatus)) return false;
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + this.cooldownMs);
      return true;
    }
    const status = extractLlmStatus(error);
    if (status == null || RETRYABLE_STATUSES.has(status) || !PAUSING_STATUSES.has(status)) {
      return false;
    }
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + this.cooldownMs);
    return true;
  }
}
