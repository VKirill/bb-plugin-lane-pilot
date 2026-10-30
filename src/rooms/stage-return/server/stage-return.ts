import { setTimeout as sleep } from "node:timers/promises";
import { RETURN_STAGES, returnAffected, type ReturnStage } from "@lane-pilot/contracts";
import { taskV2Schema } from "../../contracts";
import { createAttempt, getAttempt, getRun, getTask, getTaskPlan, listAttemptsForTask, listOpenAttempts, listStageReceipts } from "../../storage";
import { cancelAttemptById, recordStage, reopenWriterStages } from "../../runs/server";
import { createAttemptReopen, createWriterReassign } from "../../writer/server";
import { id } from "../../core/server";
import type { ServerCore, Services } from "../../core/server";
import { checkNote, pmReturnMessage, pmWriterLine, returnTurnPrompt } from "../logic";
import { finishReturn, getReturn, insertReturn, listReturns, type StageReturnRecord } from "../store";

/**
 * Return a task to an earlier stage with added context (SMA atlas delta D0-2; owner 2026-10-22: «из 4 вернуться в 1, из 5 во 2»).
 *
 * What it does, in this order: records the intervention (who, to which stage, the note word for word); works out with `returnAffected`
 * (packages/contracts/src/stage-inputs.ts) which stage receipts stay valid and which are stale, and resets the stale ones to `pending` with
 * the reason and a new input hash; pauses a running attempt the way a stop is confirmed everywhere else (the process is gone, its work is on
 * record); and restarts from the stage with the note in that stage's input.
 *
 * - writer: a running writer is replaced by a fresh one in the same worktree (the PM's reassign: no attempt is spent), a blocked writer
 *   takes the note as a turn in its own thread, a task with no writer at work gets a new attempt. The note is also in every later brief of
 *   the task (`renderReturnNotes`, read by the writer's spawn).
 * - planning, discussion: the PM does these stages, so the running attempt is stopped (cancel semantics: confirmed exit, work returned),
 *   the stale receipts are reset and the PM gets the note word for word with what to do. The old plan is not run again behind the PM's back.
 *
 * A task already accepted is refused (its work is in main: `bb lane-pilot revert`), so is one that was canceled (its stages are final) and
 * a run that is closed. Nothing is changed by a refusal.
 */

const DRAIN_MS = 30_000;

export type ReturnResult = {
  ok: boolean;
  /** Present once the intervention is on record. */
  returnId?: string;
  taskId: string;
  to?: ReturnStage;
  from?: string | null;
  reused?: string[];
  stale?: Array<{ stage: string; why: string }>;
  /** What was done to the running attempt, or null when none was running. */
  paused?: string | null;
  /** What now works on the task: a writer thread, a new attempt, or the PM. */
  restarted?: { by: "writer" | "pm"; threadId?: string | null; attemptId?: string | null; note: string };
  state: StageReturnRecord["state"] | "refused";
  reason?: string;
  next?: string;
};

export function createStageReturn(ctx: ServerCore, services: Services) {
  const { bb, db } = ctx;
  const reassign = createWriterReassign(ctx);
  const reopen = createAttemptReopen(ctx, services);
  const inFlight = new Set<string>();

  const refuse = (taskId: string, reason: string, next: string): ReturnResult => ({ ok: false, taskId, state: "refused", reason, next });

  async function tell(threadId: string | null, text: string): Promise<boolean> {
    if (!threadId) return false;
    return await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] } as never).then(() => true, () => false);
  }

  /** Waits for the writer loop of a stopped attempt to end, so what follows (the PM's update, a new attempt) does not meet it. */
  async function drained(key: string): Promise<boolean> {
    const deadline = Date.now() + DRAIN_MS;
    while (services.activeWriterTasks.has(key)) {
      if (Date.now() >= deadline || ctx.isDisposed()) return false;
      await sleep(500);
    }
    return true;
  }

  /**
   * Resets the stale receipts: a receipt that ended (passed, failed, blocked, skipped) goes back to `pending` with a new input hash, so
   * whatever runs next records over it, and its reason says why it is stale. Receipts at work or canceled are left as they are.
   */
  function markStale(runId: string, taskId: string, stale: ReadonlyArray<{ stage: string; why: string }>, returnId: string, to: ReturnStage, note: string): string[] {
    const plan = getTaskPlan(db, taskId) ?? "";
    const marked: string[] = [];
    for (const row of stale) {
      const current = listStageReceipts(db, runId, taskId).find((receipt) => receipt.stageId === row.stage);
      if (!current || !["passed", "failed", "blocked", "skipped"].includes(current.state)) continue;
      recordStage(db, { runId, taskId, stageId: row.stage as never, state: "pending", input: `${plan}\n[${returnId} returned to ${to}: ${note}]`, replaceOnNewInput: true,
        reason: `stale: ${row.why}` });
      marked.push(row.stage);
    }
    return marked;
  }

  async function returnTask(input: { ref: string; to: ReturnStage; note: string; by?: string }): Promise<ReturnResult> {
    const checked = checkNote(input.note);
    if (!checked.ok) return refuse(input.ref, checked.reason, "add --note \"what the stage did not know\"");
    if (!(RETURN_STAGES as readonly string[]).includes(input.to)) return refuse(input.ref, `unknown stage "${input.to}"`, `use one of ${RETURN_STAGES.join(", ")}`);
    const by = (input.by ?? "owner").slice(0, 60);
    const attemptRef = getAttempt(db, input.ref);
    const taskId = attemptRef ? attemptRef.task_id : input.ref;
    const row = getTask(db, taskId);
    const parsed = row?.kind === "bb" ? taskV2Schema.safeParse(row.contract) : null;
    if (!row || !parsed?.success) return refuse(taskId, `no task or attempt "${input.ref}" in Lane Pilot's records`, "check the id with `bb lane-pilot state <project-id>`");
    const task = parsed.data;
    const run = getRun(db, row.run_id);
    if (!run || run.closed_at) return refuse(taskId, `run ${row.run_id} is closed`, "send the work again in an open run");
    const attempts = listAttemptsForTask(db, row.run_id, taskId);
    const accepted = attempts.find((attempt) => attempt.state === "accepted");
    if (accepted) return refuse(taskId, `attempt ${accepted.id} of ${taskId} was accepted and merged: its work is in main`, `take it out with \`bb lane-pilot revert ${taskId}\`, then send the task again`);
    const receipts = listStageReceipts(db, row.run_id, taskId);
    if (receipts.some((receipt) => receipt.stageId === "writer-agent" && receipt.state === "canceled")) {
      return refuse(taskId, `${taskId} was canceled: its stages are final`, "send the task again with lane_pilot_dispatch_writer");
    }
    const key = `${row.run_id}:${taskId}`;
    if (inFlight.has(key)) return refuse(taskId, `${taskId} is being returned right now`, "wait for it to finish");
    inFlight.add(key);
    try {
      const affected = returnAffected(receipts.map((receipt) => ({ stage: receipt.stageId, state: receipt.state, inputSha256: receipt.inputSha256 })), input.to);
      const returnId = id("lpreturn");
      insertReturn(db, { id: returnId, at: Date.now(), projectId: run.project_id, runId: row.run_id, taskId, attemptId: null, to: input.to, from: affected.from, by,
        note: checked.note, reused: affected.reused, stale: affected.stale });
      const base = { returnId, taskId, to: input.to, from: affected.from, reused: affected.reused, stale: affected.stale };
      const fail = (reason: string, paused: string | null = null): ReturnResult => {
        finishReturn(db, returnId, { state: "failed", paused, detail: reason });
        return { ok: false, ...base, paused, state: "failed", reason, next: "look at the task with `bb lane-pilot state`; the note is on record and goes into the writer's next brief" };
      };
      const latest = attempts.at(-1);
      const open = listOpenAttempts(db).filter((attempt) => attempt.run_id === row.run_id && attempt.task_id === taskId);
      const pmThread = run.pm_thread_id ?? null;

      if (input.to === "writer") {
        // The stages that judge the work are stale before the writer works again; a stage at work is not touched.
        markStale(row.run_id, taskId, affected.stale, returnId, input.to, checked.note);
        const running = open.find((attempt) => attempt.state === "running" && attempt.thread_id);
        if (running) {
          const requested = await reassign.requestReassign({ projectId: run.project_id, runId: row.run_id, taskId, reason: `returned to the writer by ${by}: ${checked.note.replace(/\s+/g, " ").slice(0, 400)}` });
          if (!requested.ok) return fail(requested.reason);
          const paused = `writer thread ${requested.oldThreadId} stopped; its worktree carried over to a fresh writer, no attempt spent`;
          const threadId = await reassign.awaitReassignedThread(row.run_id, taskId, requested.oldAttemptNo);
          const detail = threadId ? `the new writer works in thread ${threadId}` : "the new writer has not started yet; it starts by itself";
          finishReturn(db, returnId, { state: "restarted", paused, detail });
          await tell(pmThread, pmWriterLine(taskId, by, checked.note, detail));
          return { ok: true, ...base, paused, restarted: { by: "writer", threadId, note: detail }, state: "restarted" };
        }
        if (open.length) {
          const detail = `the writer has not started (attempt ${open[0]!.state}); the note is in its first brief`;
          finishReturn(db, returnId, { state: "restarted", detail });
          await tell(pmThread, pmWriterLine(taskId, by, checked.note, detail));
          return { ok: true, ...base, paused: null, restarted: { by: "writer", attemptId: open[0]!.id, note: detail }, state: "restarted" };
        }
        if (services.activeWriterTasks.has(key)) return fail("the task's writer is still finishing; try again in a minute");
        const blocked = latest?.state === "blocked" ? getAttempt(db, latest.id) : undefined;
        const config = await ctx.configForRun(run.project_id, run);
        if (!config) return fail("Lane Pilot is not configured for this project");
        const ready = blocked ? await reopen.checkReopenable({ runId: row.run_id, taskId, run, attempt: blocked }) : null;
        if (blocked && ready?.ok) {
          const reopened = await reopen.reopenAttempt({ projectId: run.project_id, runId: row.run_id, taskId, pmThreadId: run.pm_thread_id ?? "", attempt: blocked,
            threadId: ready.threadId, workspacePath: ready.workspacePath, config, contract: task, reason: `returned to the writer by ${by}`,
            turn: returnTurnPrompt(checked.note), qaAnswer: checked.note });
          if (!reopened.ok) return fail(reopened.hint);
          const detail = `the blocked writer takes the note as a turn in its own thread ${ready.threadId}; no attempt spent`;
          finishReturn(db, returnId, { state: "restarted", detail, attemptId: blocked.id });
          await tell(pmThread, pmWriterLine(taskId, by, checked.note, detail));
          return { ok: true, ...base, paused: null, restarted: { by: "writer", threadId: ready.threadId, attemptId: blocked.id, note: detail }, state: "restarted" };
        }
        // No writer at work and none to reopen: a new attempt from the writer stage, with the note in its brief.
        reopenWriterStages(db, row.run_id, taskId, `returned to the writer by ${by}`);
        const attemptId = id("lpattempt");
        createAttempt(db, { id: attemptId, runId: row.run_id, taskId });
        const created = getAttempt(db, attemptId);
        const queued = created ? await services.enqueueResumedWriter(run.project_id, created).catch(() => false) : false;
        if (!queued) return fail("the writer could not be queued (no workspace for the run?)");
        const detail = `a new attempt ${attemptId} starts from the writer stage with the note in its brief`;
        finishReturn(db, returnId, { state: "restarted", detail, attemptId });
        await tell(pmThread, pmWriterLine(taskId, by, checked.note, detail));
        return { ok: true, ...base, paused: null, restarted: { by: "writer", attemptId, note: detail }, state: "restarted" };
      }

      // Planning and discussion are the PM's stages: stop what runs, reset what is stale, hand the PM the note.
      let paused: string | null = null;
      for (const attempt of open) {
        const stopped = await cancelAttemptById(ctx, attempt.id, services.rollback, `canceled: returned to the PM by ${by}`, "superseded");
        if (!stopped.ok) return fail(`attempt ${attempt.id} could not be stopped: ${stopped.reason ?? stopped.state}`, `attempt ${attempt.id} ${stopped.state}`);
        paused = `${paused ? `${paused}; ` : ""}attempt ${attempt.id} stopped (exit confirmed, its work is on record)`;
      }
      if (open.length && !await drained(key)) paused = `${paused}; its writer loop was still ending after ${DRAIN_MS / 1000}s`;
      markStale(row.run_id, taskId, affected.stale, returnId, input.to, checked.note);
      const delivered = await tell(pmThread, pmReturnMessage({ taskId, to: input.to, by, note: checked.note, stale: affected.stale, reused: affected.reused, stopped: paused }));
      const detail = delivered ? "the PM has the note and the list of stale receipts" : "the PM could not be reached; the note is on record";
      finishReturn(db, returnId, { state: "handed_to_pm", paused, detail });
      return { ok: true, ...base, paused, restarted: { by: "pm", note: detail }, state: "handed_to_pm" };
    } finally {
      inFlight.delete(key);
    }
  }

  /** What is on record for a task: every return with its note, stale and kept stages, and how far it got. */
  function status(taskRef: string): { taskId: string; returns: StageReturnRecord[] } | { taskId: string; returns: []; error: string } {
    const attempt = getAttempt(db, taskRef);
    const taskId = attempt ? attempt.task_id : taskRef;
    const row = getTask(db, taskId);
    if (!row) return { taskId, returns: [], error: `no task or attempt "${taskRef}" in Lane Pilot's records` };
    return { taskId, returns: listReturns(db, row.run_id, taskId) };
  }

  return { stageReturn: { returnTask, status, get: (returnId: string) => getReturn(db, returnId) } };
}

export type StageReturnApi = ReturnType<typeof createStageReturn>["stageReturn"];
