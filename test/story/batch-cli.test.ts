import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { runStoryBatchCli } from "../../src/story/batch-cli.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeTempDbPath(): string {
  return path.join(makeTempDir("story-batch-db-"), "novel.db");
}

function cleanupPath(targetPath: string): void {
  rmSync(targetPath, { recursive: true, force: true });
}

describe("story:batch cli", () => {
  it("runs multiple stubbed story batches and writes one bundle per run", async () => {
    const outputRoot = makeTempDir("story-batch-output-");
    const dbPath = makeTempDbPath();

    try {
      const result = await execa("npm", [
        "run",
        "story:batch",
        "--",
        "--runs=2",
        "--turns=3",
        "--stub-model",
        `--output-dir=${outputRoot}`,
      ], {
        cwd: repoRoot,
        env: {
          ...process.env,
          NOVEL_LLM_MODE: "anthropic-compatible",
          NOVEL_DB_PATH: dbPath,
          NOVEL_CHAPTER_EVERY_TURNS: "3",
          NOVEL_RESET_ON_START: "1",
        },
      });

      const outputLines = result.stdout.trim().split("\n").filter(Boolean);
      const summaryLines = outputLines.filter((line) => line.startsWith("run="));

      expect(summaryLines).toHaveLength(2);
      expect(summaryLines[0]).toMatch(/^run=1 bundle=.+ turns=3 chapters=1$/);
      expect(summaryLines[1]).toMatch(/^run=2 bundle=.+ turns=3 chapters=1$/);
      expect(outputLines.at(-1)).toBe("runs=2");

      const runBundleDirs = readdirSync(outputRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);

      expect(runBundleDirs).toHaveLength(2);
      for (const runBundleDir of runBundleDirs) {
        const bundlePath = path.join(outputRoot, runBundleDir);
        const bundleFiles = readdirSync(bundlePath);
        expect(bundleFiles).toEqual(expect.arrayContaining([
          "index.json",
          "world-log.jsonl",
          "chapters",
          "state",
        ]));
        const chapterFiles = readdirSync(path.join(bundlePath, "chapters"));
        expect(chapterFiles.some((fileName) => fileName.startsWith("chapter-"))).toBe(true);
      }
    } finally {
      cleanupPath(outputRoot);
      cleanupPath(path.dirname(dbPath));
    }
  });

  it("fails fast when a configured batch run fails", async () => {
    const outputRoot = makeTempDir("story-batch-output-");
    const dbPath = makeTempDbPath();

    try {
      const result = await execa("npm", [
        "run",
        "story:batch",
        "--",
        "--runs=3",
        "--turns=3",
        "--fail-on-run=2",
        "--stub-model",
        `--output-dir=${outputRoot}`,
      ], {
        cwd: repoRoot,
        reject: false,
        env: {
          ...process.env,
          NOVEL_LLM_MODE: "anthropic-compatible",
          NOVEL_DB_PATH: dbPath,
          NOVEL_CHAPTER_EVERY_TURNS: "3",
          NOVEL_RESET_ON_START: "1",
        },
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("run=2");
      const runBundleDirs = readdirSync(outputRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      expect(runBundleDirs).toHaveLength(1);
    } finally {
      cleanupPath(outputRoot);
      cleanupPath(path.dirname(dbPath));
    }
  });

  it("restores NOVEL_RESET_ON_START after an in-process batch failure", async () => {
    const outputRoot = makeTempDir("story-batch-output-");
    const dbPath = makeTempDbPath();
    const originalResetOnStart = process.env.NOVEL_RESET_ON_START;
    process.env.NOVEL_RESET_ON_START = "preserve-me";

    try {
      await expect(runStoryBatchCli([
        "--runs=1",
        "--fail-on-run=1",
        "--turns=3",
        "--stub-model",
        `--output-dir=${outputRoot}`,
      ])).rejects.toThrow("[story-runtime] configured batch failure at run=1");

      expect(process.env.NOVEL_RESET_ON_START).toBe("preserve-me");
    } finally {
      if (originalResetOnStart === undefined) {
        delete process.env.NOVEL_RESET_ON_START;
      } else {
        process.env.NOVEL_RESET_ON_START = originalResetOnStart;
      }
      cleanupPath(outputRoot);
      cleanupPath(path.dirname(dbPath));
    }
  });
});
