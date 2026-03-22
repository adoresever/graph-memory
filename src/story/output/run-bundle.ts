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
} from "./serializers.ts";

export interface WriteRunBundleInput {
  outputRoot: string;
  runMetadata: RunBundleMetadata;
}

export async function writeRunBundle(
  db: DatabaseSyncInstance,
  result: StoryLoopResult,
  input: WriteRunBundleInput,
): Promise<string> {
  const bundleDir = path.join(input.outputRoot, input.runMetadata.runId);
  const chaptersDir = path.join(bundleDir, "chapters");
  const stateDir = path.join(bundleDir, "state");

  mkdirSync(chaptersDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  writeFileSync(
    path.join(bundleDir, "index.json"),
    toPrettyJson(serializeIndexJson(result, input.runMetadata)),
    "utf8",
  );
  writeFileSync(
    path.join(bundleDir, "world-log.jsonl"),
    serializeWorldLogJsonl(result),
    "utf8",
  );

  for (let i = 0; i < result.chapters.length; i += 1) {
    const chapter = result.chapters[i];
    const chapterName = `chapter-${String(i + 1).padStart(3, "0")}.md`;
    writeFileSync(
      path.join(chaptersDir, chapterName),
      serializeChapterMarkdown(i + 1, chapter),
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

  return bundleDir;
}
