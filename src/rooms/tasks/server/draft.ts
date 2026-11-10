import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { claimTaskDraftRow, getTaskDraftRow, insertTaskDraftRow, saveDraftTaskIds } from "../../storage";

/**
 * A task draft (SMA m_sw_chat_draft / m_sw_batch_draft): the PM proposes a task-v2 (or a batch of them) and the card
 * waits in `proposed`. The owner's «Создать» button and the PM's confirmed call share `createFromDraft`, the one
 * enqueue path: claim `proposed`→`created` in one transaction (a second create reads `already_created` and never
 * enqueues twice), then dispatch every contract of the draft.
 */
export type TaskDraft = { id: string; runId: string | null; projectId: string; threadId: string | null; kind: "task" | "batch";
  contracts: unknown[]; objective: string | null; plan: string | null; state: "proposed" | "created"; taskIds: string[]; createdAt: number; updatedAt: number };
type Db = Pick<Database.Database, "prepare" | "transaction">;

const rowOf = (row: { id: string; run_id: string | null; project_id: string; thread_id: string | null; kind: string; contracts_json: string; objective: string | null; plan: string | null; state: string; task_ids_json: string | null; created_at: number; updated_at: number }): TaskDraft => ({
  id: row.id, runId: row.run_id, projectId: row.project_id, threadId: row.thread_id, kind: row.kind === "batch" ? "batch" : "task",
  contracts: JSON.parse(row.contracts_json) as unknown[], objective: row.objective, plan: row.plan,
  state: row.state === "created" ? "created" : "proposed", taskIds: row.task_ids_json ? JSON.parse(row.task_ids_json) as string[] : [],
  createdAt: row.created_at, updatedAt: row.updated_at });

export function proposeDraft(db: Db, input: { runId: string | null; projectId: string; threadId: string | null; kind?: "task" | "batch"; contracts: unknown[]; objective?: string | null; plan?: string | null; at?: number }): TaskDraft {
  const at = input.at ?? Date.now();
  const id = `dr_${randomUUID().slice(0, 12)}`;
  insertTaskDraftRow(db, { id, run_id: input.runId, project_id: input.projectId, thread_id: input.threadId, kind: input.kind ?? "task",
    contracts_json: JSON.stringify(input.contracts), objective: input.objective ?? null, plan: input.plan ?? null, state: "proposed", task_ids_json: null, created_at: at, updated_at: at });
  return getDraft(db, id)!;
}

export function getDraft(db: Db, id: string): TaskDraft | null {
  const row = getTaskDraftRow(db, id);
  return row ? rowOf(row) : null;
}

/** The one enqueue path. `dispatch` runs once per contract, after the draft is claimed; on a dispatch throw the
 *  draft stays claimed and the enqueued ids are kept — a repeat create still reads already_created. */
export async function createFromDraft(db: Db, draftId: string, dispatch: (contract: unknown) => Promise<string>): Promise<{ state: "created" | "already_created"; taskIds: string[]; runId: string | null }> {
  const draft = getDraft(db, draftId);
  if (!draft) throw new Error(`draft ${draftId} does not exist`);
  if (!claimTaskDraftRow(db, draftId, Date.now())) return { state: "already_created", taskIds: draft.taskIds, runId: draft.runId };
  const taskIds: string[] = [];
  try {
    for (const contract of draft.contracts) taskIds.push(await dispatch(contract));
  } finally {
    saveDraftTaskIds(db, draftId, JSON.stringify(taskIds), Date.now());
  }
  return { state: "created", taskIds, runId: draft.runId };
}
