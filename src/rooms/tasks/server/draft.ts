import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getTaskDraftRow, insertTaskDraftRow, pruneTaskDraftRows, saveDraftResults, type TaskDraftRow } from "../../storage";
import { ToolError } from "../../contracts/server";

/**
 * A task draft (SMA m_sw_chat_draft / m_sw_batch_draft): the PM proposes a task-v2 (or a batch of them) and the card
 * waits in `proposed`. The owner's «Создать» button and the PM's confirmed call share `createFromDraft`, the one enqueue
 * path, and each contract goes through `dispatchChecked`, the function the PM's dispatch tool calls too.
 *
 * Each contract has its own result on the draft (`created` with the task id, or `failed` with the reason). A draft with
 * failed contracts is `partial` and can be pressed again: only the contracts not yet created are sent. Presses on one
 * draft run one after another, so two overlapping presses create each contract once.
 */
export type ContractResult = { state: "created"; taskId: string } | { state: "failed"; reason: string };
export type TaskDraft = { id: string; runId: string | null; projectId: string; threadId: string | null; kind: "task" | "batch";
  contracts: unknown[]; objective: string | null; plan: string | null; state: "proposed" | "created" | "partial"; taskIds: string[];
  results: Array<ContractResult | null>; createdAt: number; updatedAt: number };
type Db = Pick<Database.Database, "prepare" | "transaction">;

/** The bound of a batch, enforced here on the server (the tool schema's max is only the first line): contracts per draft and bytes of their JSON. */
export const MAX_DRAFT_CONTRACTS = 50;
export const MAX_DRAFT_BYTES = 1_000_000;
/** Drafts untouched for this long are deleted when a new one is proposed. */
export const DRAFT_KEEP_MS = 30 * 86_400_000;

const parse = <T>(text: string | null, fallback: T): T => { if (!text) return fallback; try { return JSON.parse(text) as T; } catch { return fallback; } };

const rowOf = (row: TaskDraftRow): TaskDraft => ({
  id: row.id, runId: row.run_id, projectId: row.project_id, threadId: row.thread_id, kind: row.kind === "batch" ? "batch" : "task",
  contracts: parse<unknown[]>(row.contracts_json, []), objective: row.objective, plan: row.plan,
  state: row.state === "created" ? "created" : row.state === "partial" ? "partial" : "proposed", taskIds: parse<string[]>(row.task_ids_json, []),
  results: parse<Array<ContractResult | null>>(row.results_json, []), createdAt: row.created_at, updatedAt: row.updated_at });

export function proposeDraft(db: Db, input: { runId: string | null; projectId: string; threadId: string | null; kind?: "task" | "batch"; contracts: unknown[]; objective?: string | null; plan?: string | null; at?: number }): TaskDraft {
  const at = input.at ?? Date.now();
  if (!input.contracts.length) throw new ToolError("a draft needs at least one contract", { code: "bad_input", retryable: false, sideEffects: "none" });
  if (input.contracts.length > MAX_DRAFT_CONTRACTS) throw new ToolError(`a draft holds at most ${MAX_DRAFT_CONTRACTS} contracts, got ${input.contracts.length}`, { code: "bad_input", retryable: false, sideEffects: "none" });
  const contractsJson = JSON.stringify(input.contracts);
  if (contractsJson.length > MAX_DRAFT_BYTES) throw new ToolError(`a draft holds at most ${MAX_DRAFT_BYTES} bytes of contracts`, { code: "bad_input", retryable: false, sideEffects: "none" });
  // The bound on stored drafts: a new proposal deletes the drafts untouched for 30 days.
  pruneTaskDraftRows(db, at - DRAFT_KEEP_MS);
  const id = `dr_${randomUUID().slice(0, 12)}`;
  insertTaskDraftRow(db, { id, run_id: input.runId, project_id: input.projectId, thread_id: input.threadId, kind: input.kind ?? "task",
    contracts_json: contractsJson, objective: input.objective ?? null, plan: input.plan ?? null, state: "proposed", task_ids_json: null, results_json: null, created_at: at, updated_at: at });
  return getDraft(db, id)!;
}

export function getDraft(db: Db, id: string): TaskDraft | null {
  const row = getTaskDraftRow(db, id);
  return row ? rowOf(row) : null;
}

/** The draft of this project, or null: a window that names its project reads and creates only that project's drafts. */
export function getDraftOf(db: Db, id: string, projectId?: string | null): TaskDraft | null {
  const draft = getDraft(db, id);
  return draft && (!projectId || draft.projectId === projectId) ? draft : null;
}

/** What the dispatch tool (`lane_pilot_dispatch_writer`) is built on: the rails refusal, then the writer dispatch with all its gates. */
export type DispatchChecked = {
  dispatchRefusal(threadId: string): Promise<string | null>;
  dispatchWriter(args: { threadId: string; projectId: string; task?: never; plan?: string; baseRef?: string; objective?: string; requireObjective?: boolean }): Promise<Record<string, unknown>>;
};
export type DispatchArgs = { threadId: string; projectId: string; task: unknown; plan?: string | undefined; baseRef?: string | undefined; objective?: string | undefined };

/**
 * The one dispatch function: `lane_pilot_dispatch_writer` and every contract of a draft (the PM's confirmed call and
 * the card's button) go through it. Rails first (a heavy request in an open phase is refused), then `dispatchWriter`,
 * which holds the PM-thread and run checks, task-v2 validation, owns_paths placement, duplicates, the guards and the
 * contract lint, the spend reserve and the engine check.
 */
export async function dispatchChecked(deps: DispatchChecked, args: DispatchArgs): Promise<Record<string, unknown>> {
  const refusal = await deps.dispatchRefusal(args.threadId);
  if (refusal) throw new ToolError(refusal, { code: "phase_rails", retryable: false, sideEffects: "none" });
  return deps.dispatchWriter({ threadId: args.threadId, projectId: args.projectId, task: args.task as never, plan: args.plan, baseRef: args.baseRef, objective: args.objective, requireObjective: true } as never);
}

/** A dispatch reply is a created task only when it names one; a rejection, a lint refusal or `ok:false` is a failure with its reason. */
export function settleReply(reply: Record<string, unknown>): ContractResult {
  const taskId = typeof reply.taskId === "string" ? reply.taskId.trim() : "";
  const bad = reply.ok === false || reply.state === "rejected" || reply.state === "validation_failed";
  if (taskId && !bad) return { state: "created", taskId };
  const error = reply.error as { code?: string; hint?: string } | undefined;
  const reason = [reply.reason, error?.hint, reply.hint, error?.code].find((part): part is string => typeof part === "string" && part.trim().length > 0) ?? `dispatch answered without a task (${String(reply.state ?? "no state")})`;
  return { state: "failed", reason: reason.slice(0, 600) };
}

const pressing = new Map<string, Promise<unknown>>();

export type CreateOutcome = { state: "created" | "already_created" | "partial"; taskIds: string[]; runId: string | null; failed: Array<{ index: number; reason: string }>; results: Array<ContractResult | null> };

/**
 * The one enqueue path. Presses on one draft run one after another. Each contract not yet created is sent through
 * `dispatch` (which returns the dispatch reply) and its result stored on the draft at once; a throw or a reply with no
 * task is recorded as failed with its reason, and the loop goes on. All created → `created`; some failed → `partial`
 * (press again to send only those); nothing left to send → `already_created`.
 */
export function createFromDraft(db: Db, draftId: string, dispatch: (contract: unknown, index: number) => Promise<Record<string, unknown>>, options: { projectId?: string | null } = {}): Promise<CreateOutcome> {
  const turn = (pressing.get(draftId) ?? Promise.resolve()).then(() => press(db, draftId, dispatch, options.projectId));
  const tail = turn.catch(() => undefined);
  pressing.set(draftId, tail);
  void tail.then(() => { if (pressing.get(draftId) === tail) pressing.delete(draftId); });
  return turn;
}

async function press(db: Db, draftId: string, dispatch: (contract: unknown, index: number) => Promise<Record<string, unknown>>, projectId?: string | null): Promise<CreateOutcome> {
  const draft = getDraftOf(db, draftId, projectId);
  if (!draft) throw new Error(`draft ${draftId} does not exist`);
  if (draft.contracts.length > MAX_DRAFT_CONTRACTS) throw new Error(`draft ${draftId} holds more than ${MAX_DRAFT_CONTRACTS} contracts`);
  const results: Array<ContractResult | null> = draft.contracts.map((_, index) => draft.results[index] ?? null);
  const todo = results.map((result, index) => (result?.state === "created" ? -1 : index)).filter((index) => index >= 0);
  const summary = (state: CreateOutcome["state"]): CreateOutcome => ({ state, runId: draft.runId, results,
    taskIds: results.flatMap((result) => (result?.state === "created" ? [result.taskId] : [])),
    failed: results.flatMap((result, index) => (result?.state === "failed" ? [{ index, reason: result.reason }] : [])) });
  if (!todo.length) return summary("already_created");
  const save = () => {
    const created = results.filter((result): result is { state: "created"; taskId: string } => result?.state === "created");
    const state = created.length === results.length ? "created" : results.some((result) => result?.state === "failed") ? "partial" : "proposed";
    saveDraftResults(db, draftId, state, JSON.stringify(results), JSON.stringify(created.map((result) => result.taskId)), Date.now());
  };
  for (const index of todo) {
    try { results[index] = settleReply(await dispatch(draft.contracts[index], index)); }
    catch (cause) { results[index] = { state: "failed", reason: (cause instanceof Error ? cause.message : String(cause)).slice(0, 600) }; }
    save();
  }
  return summary(results.some((result) => result?.state === "failed") ? "partial" : "created");
}
