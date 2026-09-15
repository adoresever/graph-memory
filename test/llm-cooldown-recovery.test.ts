import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCompleteFn } from "../src/engine/llm.ts";

/**
 * P2 修复回归：LLM 冷却期间，oauthPath 会话文件被外部进程重写
 * （`openclaw graph-memory auth login` / CLI extract 刷新 token）必须
 * 立即解除冷却并重试，而不是等满 10 分钟。
 * fetch 全程 mock，绝不触网；会话文件用临时目录 + utimes 精确控制 mtime。
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, {
    recursive: true,
    force: true,
  })));
});

/** 无 expiresAt → needsRefresh=false，跳过刷新直接进入请求（fetch mock 拦截）。 */
async function writeOAuthFile(authPath: string, accessToken: string, mtime: Date): Promise<void> {
  await writeFile(authPath, JSON.stringify({
    accessToken,
    accountId: "test-account",
    providerId: "openai-codex",
  }));
  await utimes(authPath, mtime, mtime);
}

function codexSuccessResponse(): Response {
  return new Response(
    JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("LLM cooldown recovers when the OAuth session file is rewritten", () => {
  it("fast-fails during cooldown, then auto-lifts after the file changes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "graph-memory-cooldown-"));
    temporaryDirectories.push(directory);
    const oauthPath = path.join(directory, "oauth.json");

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(codexSuccessResponse());
    vi.stubGlobal("fetch", fetchMock);

    const complete = createCompleteFn("gpt-5.6-luna", { provider: "oauth", oauthPath });

    // 1) 首次调用：401（持久性凭证错误）→ 触发冷却
    await writeOAuthFile(oauthPath, "stale-token", new Date(1_700_000_000_000));
    await expect(complete("sys", "user")).rejects.toThrow(/OAuth LLM API 401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 2) 文件未变：冷却期快速失败，不再发请求
    await expect(complete("sys", "user")).rejects.toThrow(/LLM paused for \d+s/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 3) 外部进程重写会话文件（mtime 变化）→ 冷却自动解除并重试
    await writeOAuthFile(oauthPath, "fresh-token", new Date(1_700_000_060_000));
    await expect(complete("sys", "user")).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 新 token 确实被使用（第 2 次请求的 Authorization 头）
    const authHeader = fetchMock.mock.calls[1][1].headers["Authorization"];
    expect(authHeader).toBe("Bearer fresh-token");
  });

  it("keeps the cooldown while the file stays untouched", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "graph-memory-cooldown-"));
    temporaryDirectories.push(directory);
    const oauthPath = path.join(directory, "oauth.json");

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(codexSuccessResponse());
    vi.stubGlobal("fetch", fetchMock);

    const complete = createCompleteFn("gpt-5.6-luna", { provider: "oauth", oauthPath });

    await writeOAuthFile(oauthPath, "stale-token", new Date(1_700_000_000_000));
    await expect(complete("sys", "user")).rejects.toThrow(/OAuth LLM API 401/);

    // 相同 mtime 重写内容（异常场景）：mtime 未变 → 维持冷却
    await writeFile(oauthPath, JSON.stringify({
      accessToken: "same-mtime-token",
      accountId: "test-account",
      providerId: "openai-codex",
    }));
    await utimes(oauthPath, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    await expect(complete("sys", "user")).rejects.toThrow(/LLM paused for \d+s/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
