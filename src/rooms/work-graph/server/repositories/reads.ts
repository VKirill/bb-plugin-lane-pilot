import type Database from "better-sqlite3";
import { getRun, listAttemptHistory, listStageReceipts, loadProjectSettings, stageEventKeysSince, stageEventsForTask } from "../../../storage";

/** Storage reads for the work-graph room: stage events, stage receipts, attempt history, and run turn cap settings. */
export function readTaskStageEvents(db: Database.Database, runId: string, taskId: string) {
  return stageEventsForTask(db, runId, taskId);
}

export function readTaskStageReceipts(db: Database.Database, runId: string, taskId: string) {
  return listStageReceipts(db, runId, taskId);
}

export function readTaskAttempts(db: Database.Database, runId: string, taskId: string) {
  return listAttemptHistory(db, runId, taskId);
}

export function readStageEventKeysSince(db: Database.Database, since: number, projectId?: string) {
  return stageEventKeysSince(db, since, projectId);
}

export function readRunProjectId(db: Database.Database, runId: string): string | undefined {
  return getRun(db, runId)?.project_id;
}

export function readProjectTurnCapSetting(db: Database.Database, projectId: string): unknown {
  return loadProjectSettings(db, projectId)["writer.session_max_turns"];
}
