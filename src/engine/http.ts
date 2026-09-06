/**
 * graph-memory-pro — 共享 HTTP 客户端工具
 *
 * 统一 LLM / Embedding 调用的超时与重试语义（此前 llm.ts / embed.ts 各有一份
 * fetchRetry，且已发生行为分叉：llm 侧在重构中丢失了网络异常重试分支）。
 *
 * 语义：
 * - 可重试 HTTP 状态码（429/5xx）：指数退避重试
 * - 网络级异常（连接失败、连接被重置等）：同样重试
 * - 超时：默认立即抛出 HttpTimeoutError；仅当 retryOnTimeout=true 时计入重试
 *   （LLM 调用耗时长，超时重试会成倍拉长最坏阻塞时间；embedding 调用短，重试无害）
 */

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);

/** 请求超时（AbortError 的友好化包装；instanceof 可与网络异常区分） */
export class HttpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpTimeoutError";
  }
}

export interface FetchRetryOptions {
  /** 最大重试次数（不含首次），默认 3 */
  retries?: number;
  /** 单次请求超时，默认 30_000ms */
  timeoutMs?: number;
  /** 错误信息前缀（如 "[graph-memory] LLM"），保持各调用方原报错格式 */
  label?: string;
  /** 超时是否计入重试；默认 false（立即抛出） */
  retryOnTimeout?: boolean;
  /** 重试退避函数，attempt 从 0 开始；默认指数退避 1s/2s/4s…（测试可注入 0） */
  backoffMs?: (attempt: number) => number;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label = "[graph-memory]",
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new HttpTimeoutError(`${label} request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchRetry(
  url: string,
  init: RequestInit,
  opts: FetchRetryOptions = {},
): Promise<Response> {
  const {
    retries = 3,
    timeoutMs = 30_000,
    label = "[graph-memory]",
    retryOnTimeout = false,
    backoffMs = (attempt: number) => 1000 * Math.pow(2, attempt),
  } = opts;

  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetchWithTimeout(url, init, timeoutMs, label);
      if (res.ok || i >= retries || !RETRYABLE_STATUS.has(res.status)) return res;
      await new Promise((r) => setTimeout(r, backoffMs(i)));
    } catch (err) {
      if (err instanceof HttpTimeoutError && !retryOnTimeout) throw err;
      if (i >= retries) throw err;
      await new Promise((r) => setTimeout(r, backoffMs(i)));
    }
  }
  throw new Error(`${label} request failed after retries`);
}

/**
 * !res.ok 统一抛错（llm / embed 各调用方共用，消灭散落的 text().catch + slice 样板）。
 * 消息格式与既有调用方一致：`"${label} ${status}: ${errText.slice(0, sliceLen)}"`。
 */
export async function throwForStatus(res: Response, label: string, sliceLen = 200): Promise<never> {
  const errText = await res.text().catch(() => "");
  throw new Error(`${label} ${res.status}: ${errText.slice(0, sliceLen)}`);
}
