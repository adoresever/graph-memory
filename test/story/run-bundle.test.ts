import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTestDb } from "../helpers.ts";
import { initializeStoryWorld } from "../../src/story/world-state.ts";
import { runStoryLoop } from "../../src/story/runtime/run-loop.ts";
import { createStubStoryModelClient } from "../../src/story/runtime/stub-model.ts";
import { writeRunBundle } from "../../src/story/output/run-bundle.ts";

describe("story run bundle", () => {
  it("writes the complete bundle layout for a short stubbed run", async () => {
    const db = createTestDb();
    const outputDir = mkdtempSync(path.join(os.tmpdir(), "story-run-bundle-"));

    try {
      initializeStoryWorld(db);
      const loopResult = await runStoryLoop(db, {
        turns: 3,
        model: createStubStoryModelClient(),
      });

      const bundleDir = await writeRunBundle(db, loopResult, {
        outputRoot: outputDir,
        runMetadata: {
          runId: "test-run-001",
          turns: 3,
          chapterEveryTurns: 3,
        },
      });

      expect(existsSync(path.join(bundleDir, "index.json"))).toBe(true);
      expect(existsSync(path.join(bundleDir, "world-log.jsonl"))).toBe(true);
      expect(existsSync(path.join(bundleDir, "chapters", "chapter-001.md"))).toBe(true);
      expect(existsSync(path.join(bundleDir, "state", "final-world.json"))).toBe(true);
      expect(existsSync(path.join(bundleDir, "state", "final-director.json"))).toBe(true);
      expect(existsSync(path.join(bundleDir, "state", "consistency.json"))).toBe(true);

      const index = JSON.parse(readFileSync(path.join(bundleDir, "index.json"), "utf8")) as {
        schemaVersion: number;
        turnCount: number;
        chapterCount: number;
        consistencyIssueCount: number;
      };
      expect(index.schemaVersion).toBe(1);
      expect(index.turnCount).toBe(3);
      expect(index.chapterCount).toBe(1);
      expect(index.consistencyIssueCount).toBe(0);

      const worldLogLines = readFileSync(path.join(bundleDir, "world-log.jsonl"), "utf8")
        .trim()
        .split("\n");
      expect(worldLogLines).toHaveLength(3);

      const chapterMarkdown = readFileSync(path.join(bundleDir, "chapters", "chapter-001.md"), "utf8");
      expect(chapterMarkdown).toContain("# Chapter 001");
    } finally {
      db.close();
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
