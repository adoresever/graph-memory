import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { buildStoryWorldSnapshot } from "../memory/consistency.ts";
import type { StoryLoopResult } from "../runtime/run-loop.ts";
import {
  serializeChapterMarkdown,
  serializeIndexJson,
  serializeWorldLogJsonl,
  toPrettyJson,
  type RunBundleMetadata,
  type RunBundleSummary,
} from "./serializers.ts";

export interface WriteRunBundleInput {
  outputRoot: string;
  runMetadata: RunBundleMetadata;
}

export async function writeRunBundle(
  db: DatabaseSyncInstance,
  result: StoryLoopResult,
  input: WriteRunBundleInput,
): Promise<RunBundleSummary> {
  const bundlePath = path.join(input.outputRoot, input.runMetadata.runId);
  const chaptersDir = path.join(bundlePath, "chapters");
  const stateDir = path.join(bundlePath, "state");
  const chapterRecords = listCurrentRunChapters(db, result.chapters.length);

  mkdirSync(chaptersDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  writeFileSync(
    path.join(bundlePath, "index.json"),
    toPrettyJson(serializeIndexJson(result, input.runMetadata, bundlePath, input.outputRoot)),
    "utf8",
  );
  writeFileSync(
    path.join(bundlePath, "world-log.jsonl"),
    serializeWorldLogJsonl(result),
    "utf8",
  );

  for (let i = 0; i < result.chapters.length; i += 1) {
    const chapter = result.chapters[i];
    const chapterRecord = chapterRecords[i];
    const chapterName = `chapter-${String(i + 1).padStart(3, "0")}.md`;
    writeFileSync(
      path.join(chaptersDir, chapterName),
      serializeChapterMarkdown({
        chapterNumber: i + 1,
        runId: input.runMetadata.runId,
        turnNumber: chapterRecord?.turnNumber ?? i + 1,
        summary: chapter.summary,
        prose: chapter.prose,
      }),
      "utf8",
    );
  }

  writeFileSync(
    path.join(stateDir, "final-world.json"),
    toPrettyJson(buildStoryWorldSnapshot(db)),
    "utf8",
  );
  writeFileSync(
    path.join(stateDir, "final-director.json"),
    toPrettyJson(result.finalDirectorState),
    "utf8",
  );
  writeFileSync(
    path.join(stateDir, "consistency.json"),
    toPrettyJson(result.consistencyIssues),
    "utf8",
  );

  return {
    runId: input.runMetadata.runId,
    bundlePath,
    turnCount: result.worldLogs.length,
    chapterCount: result.chapters.length,
    consistencyIssueCount: result.consistencyIssues.length,
  };
}

function listCurrentRunChapters(db: DatabaseSyncInstance, chapterCount: number): Array<{
  turnNumber: number;
}> {
  if (chapterCount === 0) return [];

  const rows = db.prepare(`
    SELECT turn_number
    FROM story_chapters
    ORDER BY turn_number DESC, id DESC
    LIMIT ?
  `).all(chapterCount) as Array<{ turn_number: number }>;

  return rows
    .reverse()
    .map((row) => ({
      turnNumber: row.turn_number,
    }));
}
