import { vi } from "vitest";

/**
 * 宿主 `openclaw/plugin-sdk/core` 的测试替身（vitest.config.ts alias 注入）。
 *
 * delegating compaction 桥在真机由 OpenClaw 提供（legacy 引擎即经它走内置
 * 摘要压缩管线）；单测里所有对 index.ts 的运行时加载都会命中此 alias。
 * 默认实现返回一次成功的宿主压缩结果，具体用例可 mockResolvedValue 覆写。
 */
export const delegateCompactionToRuntime = vi.fn(async (): Promise<{
  ok: boolean;
  compacted: boolean;
  result?: { summary?: string; tokensBefore: number; tokensAfter?: number };
}> => ({
  ok: true,
  compacted: true,
  result: { summary: "host compaction summary", tokensBefore: 100, tokensAfter: 40 },
}));
