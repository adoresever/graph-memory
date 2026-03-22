import type { DatabaseSyncInstance } from "@photostructure/sqlite";
import { loadStoryConfig } from "../config.ts";
import { validateRecentChapters } from "../memory/consistency.ts";
import { buildChapterPacket, createAndStoreChapter } from "../narrative/chapter-generator.ts";
import { selectChapterFocus } from "../narrative/director.ts";
import {
  loadDirectorState,
  saveDirectorState,
  updateDirectorStateFromTurn,
  type NarrativeDirectorState,
} from "../narrative/state.ts";
import { runStoryTurn, type StoryTurnResult } from "../turn-simulator.ts";
import { initializeStoryWorld } from "../world-state.ts";
import { createStoryModelClient, type StoryModelClient } from "./model-client.ts";

export interface StoryLoopInput {
  turns: number;
  model?: StoryModelClient;
}

export interface StoryLoopResult {
  worldLogs: StoryTurnResult[];
  chapters: Array<{
    prose: string;
    summary: string;
    claims: Array<{
      subjectId: string;
      predicate: string;
      objectId?: string;
      valueText?: string;
      evidenceSpan: string;
    }>;
  }>;
  finalDirectorState: NarrativeDirectorState;
  consistencyIssues: Array<{
    chapterId: string;
    subjectId: string;
    predicate: "OWNS" | "LOCATED_IN" | "ALLY_OF" | "ENEMY_OF" | "INJURED" | "DEAD";
    objectId?: string;
    valueText?: string;
    evidenceSpan: string;
  }>;
}

export async function runStoryLoop(
  db: DatabaseSyncInstance,
  input: StoryLoopInput,
): Promise<StoryLoopResult> {
  initializeStoryWorld(db);
  const cfg = loadStoryConfig();
  const model = input.model ?? createStoryModelClient(cfg.llm);
  const chapters: StoryLoopResult["chapters"] = [];
  const worldLogs: StoryTurnResult[] = [];
  let directorState = loadDirectorState(db);
  let nextTurnNumber = getNextStoryTurnNumber(db, cfg.resetOnStart);

  for (let i = 0; i < input.turns; i += 1) {
    const turnResult = await runStoryTurn(db, { turnNumber: nextTurnNumber, model });
    worldLogs.push(turnResult);
    const chapterCandidate = await selectChapterFocus({
      events: turnResult.events,
      activeThreads: directorState.activeThreads,
      activeTensions: directorState.activeTensions,
      ensembleState: directorState.ensembleHeat,
      recentPovIds: directorState.recentPovIds,
      model,
    });
    directorState = updateDirectorStateFromTurn(db, directorState, turnResult, chapterCandidate);
    saveDirectorState(db, directorState);
    if (nextTurnNumber % cfg.chapterEveryTurns === 0) {
      const packet = buildChapterPacket(db, turnResult, directorState, chapterCandidate);
      chapters.push(await createAndStoreChapter(db, model, packet));
    }
    nextTurnNumber += 1;
  }

  return {
    worldLogs,
    chapters,
    finalDirectorState: directorState,
    consistencyIssues: validateRecentChapters(db),
  };
}

export function getNextStoryTurnNumber(db: DatabaseSyncInstance, resetOnStart: boolean): number {
  if (resetOnStart) {
    clearStoryRuntimeState(db);
    initializeStoryWorld(db);
    return 1;
  }
  return readMaxStoryTurnNumber(db) + 1;
}

export function clearStoryRuntimeState(db: DatabaseSyncInstance): void {
  deleteFrom(db, "story_turns");
  deleteFrom(db, "story_events");
  deleteFrom(db, "story_beliefs");
  deleteFrom(db, "story_chapters");
  deleteFrom(db, "story_director_state");
  deleteFrom(db, "story_narrative_signals");
}

function readMaxStoryTurnNumber(db: DatabaseSyncInstance): number {
  const row = db.prepare("SELECT MAX(turn_number) AS max_turn_number FROM story_turns").get() as
    | { max_turn_number: number | null }
    | undefined;
  return row?.max_turn_number ?? 0;
}

function deleteFrom(
  db: DatabaseSyncInstance,
  table:
    | "story_turns"
    | "story_events"
    | "story_beliefs"
    | "story_chapters"
    | "story_director_state"
    | "story_narrative_signals",
): void {
  db.prepare(`DELETE FROM ${table}`).run();
}
