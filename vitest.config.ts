import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        // 宿主 module（ambient stub 提供 CI 类型；运行时由 OpenClaw 注入）。
        // 单测没有宿主，指向 test/fixtures 的 delegateCompactionToRuntime 替身，
        // 使 index.ts 的 value import 在所有测试文件中可解析。
        find: /^openclaw\/plugin-sdk\/core$/,
        replacement: path.join(projectRoot, "test/fixtures/openclaw-plugin-sdk-core.ts"),
      },
    ],
  },
  test: {
    globals: true,
    testTimeout: 10_000,
    // 单 fork 串行：4 个集成测试文件共享同一 Neo4j 实例，
    // 并发跑 initSchema() 会导致 DDL 锁冲突（ForsetiClient deadlock）
    // 与 "equivalent index already exists" 错误
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
