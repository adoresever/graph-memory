import type { StoryLoopResult } from "../runtime/run-loop.ts";

export interface RunBundleMetadata {
  runId: string;
  turns: number;
  chapterEveryTurns: number;
}

export function serializeIndexJson(
  result: StoryLoopResult,
  metadata: RunBundleMetadata,
) {
  return {
    schemaVersion: 1,
    runId: metadata.runId,
    turnCount: result.worldLogs.length,
    chapterCount: result.chapters.length,
    consistencyIssueCount: result.consistencyIssues.length,
    chapterEveryTurns: metadata.chapterEveryTurns,
  };
}

export function serializeWorldLogJsonl(result: StoryLoopResult): string {
  if (result.worldLogs.length === 0) return "";
  return `${result.worldLogs.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

export function serializeChapterMarkdown(chapterNumber: number, chapter: StoryLoopResult["chapters"][number]): string {
  const ordinal = String(chapterNumber).padStart(3, "0");
  const parts = [
    `# Chapter ${ordinal}`,
    "",
    chapter.summary,
    "",
    chapter.prose,
  ];
  return parts.join("\n");
}

export function toPrettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
