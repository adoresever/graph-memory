/**
 * graph-memory — src/engine/http.ts 单元测试
 *
 * 覆盖统一的超时/重试语义：
 * - 可重试状态码（429/5xx）指数退避重试
 * - 网络异常重试（llm.ts 侧曾在此丢失，回归保护）
 * - 超时默认立即抛出（HttpTimeoutError），retryOnTimeout=true 时计入重试
 * - 不可重试状态码（401 等）立即返回响应
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchRetry, HttpTimeoutError } from "../src/engine/http.ts";

const NO_BACKOFF = { backoffMs: () => 0 };

function jsonResponse(status: number): Response {
  return new Response(JSON.stringify({ ok: false }), { status });
}

/** 永远挂起、仅在 abort 信号触发时以 AbortError 拒绝的 mock fetch（模拟超时） */
function hangingFetch() {
  return vi.fn((_url: string, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchRetry 状态码重试", () => {
  it("429 两次后 200：重试并成功，共请求 3 次", async () => {
    const mock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", mock);

    const res = await fetchRetry("https://x.test/v1", { method: "POST" }, NO_BACKOFF);

    expect(res.ok).toBe(true);
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it("持续 500：重试耗尽后返回最后一次响应（由调用方产出带状态码的报错）", async () => {
    const mock = vi.fn().mockResolvedValue(jsonResponse(500));
    vi.stubGlobal("fetch", mock);

    const res = await fetchRetry("https://x.test/v1", { method: "POST" }, NO_BACKOFF);

    expect(res.status).toBe(500);
    expect(mock).toHaveBeenCalledTimes(4); // 首次 + 3 次重试
  });

  it("401 不可重试：立即返回，仅请求 1 次", async () => {
    const mock = vi.fn().mockResolvedValue(jsonResponse(401));
    vi.stubGlobal("fetch", mock);

    const res = await fetchRetry("https://x.test/v1", { method: "POST" }, NO_BACKOFF);

    expect(res.status).toBe(401);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe("fetchRetry 网络异常重试（llm.ts 侧曾丢失的行为）", () => {
  it("网络错误后成功：重试生效", async () => {
    const err = new Error("socket hang up");
    const mock = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", mock);

    const res = await fetchRetry("https://x.test/v1", { method: "POST" }, NO_BACKOFF);

    expect(res.ok).toBe(true);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("持续网络错误：重试耗尽后抛出最后一次错误", async () => {
    const mock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    vi.stubGlobal("fetch", mock);

    await expect(
      fetchRetry("https://x.test/v1", { method: "POST" }, NO_BACKOFF),
    ).rejects.toThrow("ECONNRESET");
    expect(mock).toHaveBeenCalledTimes(4);
  });
});

describe("fetchRetry 超时语义", () => {
  it("默认超时不重试：立即抛 HttpTimeoutError，仅请求 1 次", async () => {
    const mock = hangingFetch();
    vi.stubGlobal("fetch", mock);

    await expect(
      fetchRetry("https://x.test/v1", { method: "POST" }, { timeoutMs: 30, ...NO_BACKOFF }),
    ).rejects.toBeInstanceOf(HttpTimeoutError);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("retryOnTimeout=true：超时计入重试，第 2 次成功", async () => {
    const mock = vi.fn()
      .mockImplementationOnce((_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", mock);

    const res = await fetchRetry(
      "https://x.test/v1",
      { method: "POST" },
      { timeoutMs: 30, retryOnTimeout: true, ...NO_BACKOFF },
    );

    expect(res.ok).toBe(true);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("超时错误信息包含 label 与时长", async () => {
    vi.stubGlobal("fetch", hangingFetch());

    await expect(
      fetchRetry(
        "https://x.test/v1",
        { method: "POST" },
        { timeoutMs: 25, label: "[graph-memory] LLM", ...NO_BACKOFF },
      ),
    ).rejects.toThrow("[graph-memory] LLM request timed out after 25ms");
  });
});
