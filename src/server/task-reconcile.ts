import { createMergeIntentRecovery } from "../rooms/verification/server/merge-intent";
import { closeOrphanWriterStages } from "./stage-records";
import type { ServerCore } from "./core";
import type { Services } from "./services";

/** A periodic pass leaves an attempt that moved this recently alone: a loop between two attempts is not an orphan. */
const PERIODIC_IDLE_MS = 3 * 60_000;
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
  const intents = createMergeIntentRecovery(ctx, services);

  async function reconcileTasks(options:{ phase:ReconcilePhase; step?:StepRunner; afterResume?:() => Promise<unknown> | unknown; now?:number }):Promise<void> {
    const startup = options.phase === "startup";
    const step:StepRunner = options.step ?? (async (name, work) => {
      if (ctx.isDisposed()) return;
      try { await work(); } catch (cause) { bb.log.warn(`Lane Pilot ${name} skipped: ${cause instanceof Error ? cause.message : String(cause)}`); }
    });
    await step("merge intents", () => intents.recoverMergeIntents({ now:options.now, graceMs:startup ? 0 : PERIODIC_INTENT_GRACE_MS }));
    if (startup) {
      await step("resume on start", () => services.resumeOrphans());
      if (options.afterResume) await step("start-up sweeps", options.afterResume);
    }
    await step("stage cleanup", () => {
      const closed = closeOrphanWriterStages(db, services.activeWriterTasks, startup ? 0 : PERIODIC_IDLE_MS, options.now);
      if (closed) bb.log.info(`Lane Pilot closed ${closed} writer stage(s) left open after their task ended`);
    });
    await step("parking of blocked tasks", () => services.stability.adoptBlockedByFaults(options.now));
    await step("parked-task sweep", () => services.stability.sweep(options.now));
    await step("workflow runs", async () => {
      await services.workflowEngine?.resume();
      await services.workflowEngine?.poll();
    });
  }

  return { reconcileTasks, recoverMergeIntents:intents.recoverMergeIntents };
}

export type TaskReconcile = ReturnType<typeof createTaskReconcile>;
