import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("story:batch cli", () => {
  afterEach(() => {
    const defaultRunsDir = path.join(repoRoot, "runs");
    if (existsSync(defaultRunsDir) && readdirSync(defaultRunsDir).length === 0) {
      rmSync(defaultRunsDir, { recursive: true, force: true });
    }
  });

  it("runs multiple stubbed story batches and writes one bundle per run", async () => {
    const outputRoot = mkdtempSync(path.join(os.tmpdir(), "story-batch-output-"));

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
          NOVEL_DB_PATH: `/tmp/story-batch-${Date.now()}.db`,
          NOVEL_CHAPTER_EVERY_TURNS: "3",
          NOVEL_RESET_ON_START: "1",
        },
      });

      expect(result.stdout).toContain("runs=2");
      const runBundleDirs = readdirSync(outputRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);

      expect(runBundleDirs).toHaveLength(2);
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it("fails fast when a configured batch run fails", async () => {
    const result = await execa("npm", [
      "run",
      "story:batch",
      "--",
      "--runs=3",
      "--turns=3",
      "--fail-on-run=2",
      "--stub-model",
    ], {
      cwd: repoRoot,
      reject: false,
      env: {
        ...process.env,
        NOVEL_LLM_MODE: "anthropic-compatible",
        NOVEL_DB_PATH: `/tmp/story-batch-${Date.now()}.db`,
        NOVEL_CHAPTER_EVERY_TURNS: "3",
        NOVEL_RESET_ON_START: "1",
      },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("run=2");
  });
});
