import { getAttempt, getTask, getRunSettingsScopes, listAttemptsForTask, listOpenAttempts, loadPrototypeConfig, loadProjectSettings, transitionAttempt } from "../../storage";
import { retireAreaWriter } from "./sticky";
import type { ServerCore } from "../../core/server";

/**
 * lane_pilot_reassign_task: a running task moves to a fresh writer thread in the same worktree, on the model the PM names (or the
 * current writer settings). The old writer is stopped; the writer loop (start.ts) reads the request when the stopped attempt ends
 * and starts the next writer on the old worktree, so no attempt is spent (the old attempt is free: failure-class.ts `reassign`).
 */

/** What the writer loop needs to start the reassigned task's next writer. `selection` is null when the PM named no model. */
export type ReassignRequest = {
  reason: string;
  selection: { providerId: string; model: string; reasoningLevel?: string } | null;
};

type Kv = { get(key: string): Promise<unknown>; set(key: string, value: never): Promise<unknown> };

const requestKey = (attemptId: string) => `reassign-request:${attemptId}`;

export async function saveReassignRequest(kv: Kv, attemptId: string, request: ReassignRequest): Promise<void> {
  await kv.set(requestKey(attemptId), request as never);
}

/** The request left for a stopped writer, taken once: the writer loop reads it when that attempt ends. */
export async function takeReassignRequest(kv: Kv, attemptId: string): Promise<ReassignRequest | null> {
  const value = await kv.get(requestKey(attemptId)).catch(() => null);
  if (!value || typeof value !== "object") return null;
  await kv.set(requestKey(attemptId), null as never);
  return value as ReassignRequest;
}

/** The reason the stopped attempt ends with: failure-class.ts reads it as the free `reassign` class. */
export const reassignedReason = (note:string):string => `reassigned: ${note.replace(/\s+/g, " ").trim().slice(0, 300)}`;

export type ReassignInput = {
  projectId: string; runId: string; taskId: string;
  providerId?: string; model?: string; reasoningEffort?: string; reason?: string;
};

export type ReassignRequested = { ok: true; taskId: string; runId: string; oldThreadId: string; oldAttemptNo: number; providerId: string; model: string };
export type ReassignRefusal = { ok: false; error: "not_reassignable"; taskId: string; state: string; reason: string };
export type ReassignResult =
  | { ok: true; taskId: string; oldThreadId: string; newThreadId: string | null; providerId: string; model: string }
  | ReassignRefusal;

const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;

/** Waits until the writer loop has started the reassigned task's next writer, and returns its thread (null on timeout). */
export async function awaitReassignedThread(db: ServerCore["db"], runId: string, taskId: string, oldAttemptNo: number,
  timeoutMs: number, sleep: (ms: number) => Promise<void>): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const next = listAttemptsForTask(db, runId, taskId).find((row) => row.attempt_no > oldAttemptNo && row.thread_id);
    if (next?.thread_id) return next.thread_id;
    if (Date.now() >= deadline) return null;
    await sleep(1000);
  }
}

export function createWriterReassign(ctx: Pick<ServerCore, "bb" | "db">, options: { timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {}) {
  const { bb, db } = ctx;
  const kv = bb.storage.kv as unknown as Kv;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  /** Saves the request and stops the task's running writer; the writer loop starts the next one once the stop ends the attempt. */
  async function requestReassign(input: ReassignInput): Promise<ReassignRequested | ReassignRefusal> {
    const refuse = (state: string, reason: string): ReassignRefusal => ({ ok: false, error: "not_reassignable", taskId: input.taskId, state, reason });
    const latest = listAttemptsForTask(db, input.runId, input.taskId).at(-1);
    if (!latest) return refuse("missing", "the task has no writer attempt in this run");
    const open = listOpenAttempts(db).find((row) => row.run_id === input.runId && row.task_id === input.taskId);
    if (!open) return refuse(latest.state, `the task is ${latest.state}: only a task with a running writer can be reassigned`);
    if (open.state !== "running" || !open.thread_id) {
      return refuse(open.state, `its writer is ${open.state}: only a running writer can be reassigned (a queued task starts with the current settings)`);
    }
    const oldAttemptNo = getAttempt(db, open.id)?.attempt_no ?? latest.attempt_no;

    const settings = loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId));
    const config = loadPrototypeConfig(db, input.projectId);
    const current = {
      providerId: text(settings["writer.provider"]) ?? config?.writerProviderId ?? "",
      model: text(settings["writer.model"]) ?? config?.writerModel ?? "",
    };
    const named = text(input.providerId) || text(input.model) || text(input.reasoningEffort);
    const selection = named
      ? { providerId: text(input.providerId) ?? current.providerId, model: text(input.model) ?? current.model,
        ...(text(input.reasoningEffort) ? { reasoningLevel: text(input.reasoningEffort) } : {}) }
      : null;
    const target = selection ?? current;
    if (!target.providerId || !target.model) return refuse(open.state, "no writer provider or model to move to: pass providerId and model");

    // The request is saved before the stop: the writer loop that sees the stopped attempt end must find it.
    const note = text(input.reason) ?? "reassigned by the PM";
    await saveReassignRequest(kv, open.id, { reason: note, selection });
    transitionAttempt(db, open.id, "cancel_requested", { threadId: open.thread_id });
    await bb.sdk.threads.stop({ threadId: open.thread_id });

    const area = (getTask(db, input.taskId)?.contract as { area?: unknown } | undefined)?.area;
    if (typeof area === "string" && area.trim()) await retireAreaWriter(kv, input.projectId, area, open.thread_id);

    return { ok: true, taskId: input.taskId, runId: input.runId, oldThreadId: open.thread_id, oldAttemptNo, providerId: target.providerId, model: target.model };
  }

  /** The tool: requests the reassignment and returns the new writer's thread once the writer loop has started it. */
  async function reassignTask(input: ReassignInput): Promise<ReassignResult> {
    const requested = await requestReassign(input);
    if (!requested.ok) return requested;
    const newThreadId = await awaitReassignedThread(db, requested.runId, requested.taskId, requested.oldAttemptNo, timeoutMs, sleep);
    return { ok: true, taskId: requested.taskId, oldThreadId: requested.oldThreadId, newThreadId, providerId: requested.providerId, model: requested.model };
  }

  return { requestReassign, reassignTask, awaitReassignedThread: (runId: string, taskId: string, oldAttemptNo: number) =>
    awaitReassignedThread(db, runId, taskId, oldAttemptNo, timeoutMs, sleep) };
}
