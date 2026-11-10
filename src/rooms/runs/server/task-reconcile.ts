import { closeOrphanWriterStages } from "./stage-records";
import type { ServerCore } from "../../contracts/server";

import type { ResumeOrphansPort } from "../../contracts/stability-api";
import type { StabilityPort } from "../../contracts/stability-api";
import type { WorkflowEngineApi } from "../../platform/server";
import type { WriterStateApi } from "../../platform/server";

import type { DocsNightlyPort } from "../../contracts/docs-nightly-api";
import type { MergeIntentsApi } from "../../contracts/merge-intents";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  activeWriterTasks: WriterStateApi["activeWriterTasks"];
  docsPlaces: DocsNightlyPort["docsPlaces"];
  resumeOrphans: ResumeOrphansPort["resumeOrphans"];
  stability: StabilityPort;
  recoverMergeIntents: MergeIntentsApi["recoverMergeIntents"];
  startAfterAcceptance: WorkflowEngineApi["startAfterAcceptance"];
  workflowEngine: WorkflowEngineApi["workflowEngine"];
}


/** A periodic pass leaves an attempt that moved this recently alone: a loop between two attempts is not an orphan. */
const PERIODIC_IDLE_MS = 3 * 60_000;
/** A take-back that did not move the attempt is tried again this long after. */
const TAKE_BACK_RETRY_MS = 15 * 60_000;
/** ...and a merge intent this recent: the merge may still be running on the machine. */
const PERIODIC_INTENT_GRACE_MS = 2 * 60_000;

export type ReconcilePhase = "startup" | "periodic";
type StepRunner = (name:string, work:() => Promise<unknown> | unknown) => Promise<void>;

/**
 * The one ordered pass that brings tasks back after a reload, a lost reply or a dead loop: at start-up, and every five
 * minutes after. Before 0.1.177 each step ran by itself at start-up, and the stage cleanup (which ends an attempt that
 * waits for a retry nobody will run) came after the parking of blocked tasks: such a task was parked only on the next
 * start. The order is the contract:
 *  1. merge intents: work already in main is accepted before anything redoes it;
 *  2. (start-up only) resume the attempts in flight, with the caller's steps that follow;
 *  3. orphan writer stages: a failed attempt waiting for a retry that died with its loop ends here;
 *  4. parking: tasks blocked by Lane Pilot's or the machine's fault, that one included, are parked;
 *  5. the parked-task sweep restarts those whose fault is fixed or whose backoff is over;
 *  6. the workflow runs: those a reload left are picked up or ended, and a run waiting for its code task is settled
 *     from the task's attempt, which steps 1-5 have just brought up to date.
 */
export function createTaskReconcile(ctx:ServerCore, services:Services) {
  const { bb, db } = ctx;
  const takeBackTried = new Map<string, number>();
  
  async function reconcileTasks(options:{ phase:ReconcilePhase; step?:StepRunner; afterResume?:() => Promise<unknown> | unknown; now?:number }):Promise<void> {
    const startup = options.phase === "startup";
    const step:StepRunner = options.step ?? (async (name, work) => {
      if (ctx.isDisposed()) return;
      try { await work(); } catch (cause) { bb.log.warn(`Lane Pilot ${name} skipped: ${cause instanceof Error ? cause.message : String(cause)}`); }
    });
    await step("merge intents", () => services.recoverMergeIntents({ now:options.now, graceMs:startup ? 0 : PERIODIC_INTENT_GRACE_MS }));
    if (startup) {
      await step("resume on start", () => services.resumeOrphans());
      if (options.afterResume) await step("start-up sweeps", options.afterResume);
    }
    await step("stage cleanup", () => {
      const closed = closeOrphanWriterStages(db, services.activeWriterTasks, startup ? 0 : PERIODIC_IDLE_MS, options.now, services.stability.reconcileScanOpen);
      if (closed) bb.log.info(`Lane Pilot closed ${closed} writer stage(s) left open after their task ended`);
    });
    if (!startup) {
      // The lease is the live loop (SMA tr_claimed): an attempt whose run:task is not in activeWriterTasks and that has not
      // moved for PERIODIC_IDLE_MS lost its hold — it goes through the same resume path start-up recovery uses, so a dead
      // loop's work is taken back instead of standing at «running» until the next reload.
      await step("lease take-back", async () => {
        const cutoff = (options.now ?? Date.now()) - PERIODIC_IDLE_MS;
        const lost = (db.prepare(`SELECT id, run_id, task_id FROM lane_pilot_attempt WHERE state IN ('spawn_requested','spawn_unknown','running','cancel_requested') AND updated_at < ?`)
          .all(cutoff) as Array<{ id: string; run_id: string; task_id: string }>)
          .filter((row) => !services.activeWriterTasks.has(`${row.run_id}:${row.task_id}`))
          .map((row) => row.id)
          // An attempt the resume could not start again (its run or contract is gone) is not asked about every minute.
          .filter((id) => cutoff + PERIODIC_IDLE_MS - (takeBackTried.get(id) ?? 0) >= TAKE_BACK_RETRY_MS);
        for (const id of lost) takeBackTried.set(id, cutoff + PERIODIC_IDLE_MS);
        if (lost.length) {
          const took = await services.resumeOrphans(undefined, lost);
          bb.log.info(`Lane Pilot took back ${took.resumed.length + took.finished.length} attempt(s) whose hold had lapsed${took.skipped.length ? ` (${took.skipped.length} skipped)` : ""}`);
        }
      });
    }
    await step("parking of blocked tasks", () => services.stability.adoptBlockedByFaults(options.now));
    await step("parked-task sweep", () => services.stability.sweep(options.now));
    await step("workflow runs", async () => {
      await services.workflowEngine?.resume();
      await services.workflowEngine?.poll();
    });
  }

  return { reconcileTasks, recoverMergeIntents:services.recoverMergeIntents };
}

export type TaskReconcile = ReturnType<typeof createTaskReconcile>;
