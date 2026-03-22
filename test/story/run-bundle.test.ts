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
    const startedAt = "2026-03-22T10:00:00.000Z";
    const finishedAt = "2026-03-22T10:00:05.000Z";

    try {
      initializeStoryWorld(db);
      const loopResult = await runStoryLoop(db, {
        turns: 3,
        model: createStubStoryModelClient(),
      });

      const bundle = await writeRunBundle(db, loopResult, {
        outputRoot: outputDir,
        runMetadata: {
          runId: "test-run-001",
          turns: 3,
          chapterEveryTurns: 3,
          dbPath: "/tmp/story.db",
          resetOnStart: true,
          model: { mode: "stub", name: "stub-story-model" },
          startedAt,
          finishedAt,
        },
      });

      expect(bundle).toMatchObject({
        runId: "test-run-001",
        bundlePath: path.join(outputDir, "test-run-001"),
        turnCount: 3,
        chapterCount: 1,
        consistencyIssueCount: 0,
      });

      expect(existsSync(path.join(bundle.bundlePath, "index.json"))).toBe(true);
      expect(existsSync(path.join(bundle.bundlePath, "world-log.jsonl"))).toBe(true);
      expect(existsSync(path.join(bundle.bundlePath, "chapters", "chapter-001.md"))).toBe(true);
      expect(existsSync(path.join(bundle.bundlePath, "state", "final-world.json"))).toBe(true);
      expect(existsSync(path.join(bundle.bundlePath, "state", "final-director.json"))).toBe(true);
      expect(existsSync(path.join(bundle.bundlePath, "state", "consistency.json"))).toBe(true);

      const index = JSON.parse(readFileSync(path.join(bundle.bundlePath, "index.json"), "utf8")) as {
        schemaVersion: number;
        runId: string;
        startedAt: string;
        finishedAt: string;
        turnCount: number;
        chapterCount: number;
        consistencyIssueCount: number;
        chapterEveryTurns: number;
        dbPath: string;
        resetOnStart: boolean;
        model: { mode: string; name: string };
        bundlePath: string;
        outputRoot: string;
      };
      expect(index.schemaVersion).toBe(1);
      expect(index.runId).toBe("test-run-001");
      expect(index.startedAt).toBe(startedAt);
      expect(index.finishedAt).toBe(finishedAt);
      expect(index.turnCount).toBe(3);
      expect(index.chapterCount).toBe(1);
      expect(index.consistencyIssueCount).toBe(0);
      expect(index.chapterEveryTurns).toBe(3);
      expect(index.dbPath).toBe("/tmp/story.db");
      expect(index.resetOnStart).toBe(true);
      expect(index.model).toEqual({ mode: "stub", name: "stub-story-model" });
      expect(index.bundlePath).toBe(path.join(outputDir, "test-run-001"));
      expect(index.outputRoot).toBe(outputDir);

      const worldLogLines = readFileSync(path.join(bundle.bundlePath, "world-log.jsonl"), "utf8")
        .trim()
        .split("\n");
      expect(worldLogLines).toHaveLength(3);

      const chapterMarkdown = readFileSync(path.join(bundle.bundlePath, "chapters", "chapter-001.md"), "utf8");
      expect(chapterMarkdown).toContain("# Chapter 001");
      expect(chapterMarkdown).toContain("- Run: test-run-001");
      expect(chapterMarkdown).toContain("- Turn: 3");
      expect(chapterMarkdown).toContain("- Summary: ");
      expect(chapterMarkdown).toMatch(/\n\nStub chapter turn 3 focus /);
    } finally {
      db.close();
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
