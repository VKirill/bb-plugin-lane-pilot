import type Database from "better-sqlite3";
import { getTaskDraftRow, insertTaskDraftRow, pruneTaskDraftRows, saveDraftResults, type TaskDraftRow } from "../../../storage";

export type DraftDb = Pick<Database.Database, "prepare" | "transaction">;
export type { TaskDraftRow };

export function findTaskDraftRow(db: DraftDb, id: string): TaskDraftRow | undefined {
  return getTaskDraftRow(db, id) ?? undefined;
}

export function createTaskDraftRow(
  db: DraftDb,
  row: {
    id: string;
    run_id: string | null;
    project_id: string;
    thread_id: string | null;
    kind: "task" | "batch";
    contracts_json: string;
    objective: string | null;
    plan: string | null;
    state: "proposed" | "created" | "partial";
    task_ids_json: string | null;
    results_json: string | null;
    created_at: number;
    updated_at: number;
  },
): void {
  insertTaskDraftRow(db, row);
}

export function pruneStaleTaskDraftRows(db: DraftDb, cutoffAt: number): void {
  pruneTaskDraftRows(db, cutoffAt);
}

export function updateTaskDraftResults(
  db: DraftDb,
  draftId: string,
  state: "proposed" | "created" | "partial",
  resultsJson: string,
  taskIdsJson: string,
  updatedAt: number,
): void {
  saveDraftResults(db, draftId, state, resultsJson, taskIdsJson, updatedAt);
}
