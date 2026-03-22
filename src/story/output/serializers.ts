import type { StoryLoopResult } from "../runtime/run-loop.ts";

export interface RunBundleModelMetadata {
  mode: string;
  name: string;
}

export interface RunBundleMetadata {
  runId: string;
  turns: number;
  chapterEveryTurns: number;
  dbPath: string;
  resetOnStart: boolean;
  model: RunBundleModelMetadata;
  startedAt: string;
  finishedAt: string;
}

export interface RunBundleSummary {
  runId: string;
  bundlePath: string;
  turnCount: number;
  chapterCount: number;
  consistencyIssueCount: number;
}

export interface RunBundleIndexJson {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  finishedAt: string;
  turnCount: number;
  chapterCount: number;
  consistencyIssueCount: number;
  chapterEveryTurns: number;
  dbPath: string;
  resetOnStart: boolean;
  model: RunBundleModelMetadata;
  bundlePath: string;
  outputRoot: string;
}

export function serializeIndexJson(
  result: StoryLoopResult,
  metadata: RunBundleMetadata,
  bundlePath: string,
  outputRoot: string,
): RunBundleIndexJson {
  return {
    schemaVersion: 1,
    runId: metadata.runId,
    startedAt: metadata.startedAt,
    finishedAt: metadata.finishedAt,
    turnCount: result.worldLogs.length,
    chapterCount: result.chapters.length,
    consistencyIssueCount: result.consistencyIssues.length,
    chapterEveryTurns: metadata.chapterEveryTurns,
    dbPath: metadata.dbPath,
    resetOnStart: metadata.resetOnStart,
    model: metadata.model,
    bundlePath,
    outputRoot,
  };
}

export function serializeWorldLogJsonl(result: StoryLoopResult): string {
  if (result.worldLogs.length === 0) return "";
  return `${result.worldLogs.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

export function serializeChapterMarkdown(input: {
  chapterNumber: number;
  runId: string;
  turnNumber: number;
  summary: string;
  prose: string;
}): string {
  const ordinal = String(input.chapterNumber).padStart(3, "0");
  const parts = [
    `# Chapter ${ordinal}`,
    "",
    `- Run: ${input.runId}`,
    `- Turn: ${input.turnNumber}`,
    `- Summary: ${input.summary}`,
    "",
    input.prose,
    "",
  ];
  return parts.join("\n");
}

export function toPrettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
