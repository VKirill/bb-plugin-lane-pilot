import { endSpawnFailure, getAttempt } from "../../storage";
import type { ServerCore } from "../../contracts/server";
import type { SpawnInput, SpawnResult } from "./spawn-types";

export type WorkflowWake = () => Promise<unknown> | unknown;

/** Do not wait for the active writer/workflow drive while notifying a terminal cancellation. */
export function wakeWorkflowAfterCancellation(log:(message:string)=>void, wake:WorkflowWake | undefined): void {
  if (!wake) return;
  void Promise.resolve().then(wake).catch((cause:unknown) => {
    log(`Lane Pilot workflow wake after cancellation skipped: ${cause instanceof Error ? cause.message : String(cause)}`);
  });
}

/** Generous over a big repo's worktree, baseline and holder start (minutes); a start past it waits on something that will not answer. */
export const START_STALL_MS = 15 * 60_000;
const START_POLL_MS = 15_000;
export const startSteps = new Map<string, string>();

/**
 * A start that never makes its thread ends instead of holding the attempt «starting» and its task's slots forever: a stop
 * request ends it within a poll, and a start with no thread after START_STALL_MS fails with the step it waited at.
 * Drill 2026-11-07 (0.1.483): parallel3 task a waited on BB or the machine with no answer and no log; its stop never landed.
 */
export async function spawnWriterAttemptWatched(deps:{ db:ServerCore["db"]; log:(message:string)=>void; wakeWorkflow?:WorkflowWake },
  input:SpawnInput, once:(input:SpawnInput)=>Promise<SpawnResult>): Promise<SpawnResult> {
  const { db, log } = deps;
  const started = Date.now();
  let poll: ReturnType<typeof setInterval> | undefined;
  const watchdog = new Promise<SpawnResult>((resolve) => {
    poll = setInterval(() => {
      const state = getAttempt(db, input.attemptId)?.state;
      const step = startSteps.get(input.attemptId) ?? "start";
      const stalled = Date.now() - started >= START_STALL_MS;
      if (state === "spawn_requested" && !stalled) return;
      if (state !== "spawn_requested" && state !== "cancel_requested") return;
      const reason = state === "cancel_requested" ? `stopped while the writer start waited at step ${step}`
        : `writer_start_stalled: no writer thread after ${Math.round(START_STALL_MS / 60_000)} min, waiting at step ${step}`;
      log(`Lane Pilot writer ${input.attemptId}: ${reason}`);
      const status = endSpawnFailure(db, input.attemptId, reason);
      if (status === "canceled") wakeWorkflowAfterCancellation(log, deps.wakeWorkflow);
      resolve({ ok:false, status, reason, attemptId:input.attemptId });
    }, START_POLL_MS);
    poll.unref?.();
  });
  try { return await Promise.race([once(input), watchdog]); }
  finally { clearInterval(poll); }
}
