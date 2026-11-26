import { getRun, listStageReceipts } from "../../../storage";
import { withUsage } from "../../../usage/server";
import { requireGreen } from "@lane-pilot/workflow-engine";
import type { NodeExecutor, StepContext, WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../../../contracts/server";
import type { MemoryStageApi } from "../../../memory/server";
/** The writer's attempt-finished subscription, injected (writer imports this room, so the function cannot be imported). */
export type OnAttemptFinished = (ctx: ServerCore, subscriber: (event: { scope: string; status: string; projectId: string; runId: string; taskId: string; pmThreadId: string }) => void | Promise<void>, name?: string) => void;
import { AFTER_ACCEPT } from "../../../contracts";
import { builtinWorkflow } from "../../builtin";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  runMemoryMaintenance: MemoryStageApi["runMemoryMaintenance"];
}

/**
 * The after-acceptance graph (`workflows/lp.after-accept.json`): started once an accepted task landed on the base
 * branch (never offered, never sends a PM message). Runs memory maintenance. A failure marks the graph run failed,
 * never the accepted task.
 */

export const afterAcceptKey = (runId: string, taskId: string) => `after-accept:${runId}:${taskId}`;

/** How many `timeoutSec = 60` rounds a step waits for a running helper thread (20 minutes, well under the step's deadline). */
const ROUNDS = 20;

type Stage = "memory-maintenance";
type Row = Record<string, unknown>;
const text = (value: unknown): string => (typeof value === "string" ? value : "");

export function registerAfterAcceptExecutors(engine: WorkflowEngine, ctx: ServerCore, services: Services): void {
  const { bb, db } = ctx;

  /**
   * One stage as one step: the stage function is called until its receipt is final.
   * The helper thread it spawned is read for what it spent and the engine adds that to the run.
   */
  const stageStep = (stage: Stage, call: (args: { threadId: string; projectId: string; runId: string; taskId: string; timeoutSec: number; workflow: { runId: string; stepKey: string; nodeId: string } }) => Promise<Row>): NodeExecutor => ({
    // The stage functions are idempotent by their receipts and spawn keys: a step a reload cut off is simply run again.
    reentrant: true,
    run: async (c: StepContext) => {
      const runId = text(c.inputs.run_id), taskId = text(c.inputs.task_id), threadId = text(c.inputs.pm_thread_id);
      const projectId = engine.journal.getRun(c.runId)?.project_id ?? getRun(db, runId)?.project_id ?? "";
      const since = Date.now();
      const done = async (output: Row) => {
        const receipt = listStageReceipts(db, runId, taskId).find((row) => row.stageId === stage);
        const usage = receipt?.threadId && receipt.updatedAt >= since ? await withUsage(bb, receipt.threadId) : {};
        const state = text(output.state), reason = text(output.reason);
        return { output: { state, ...(reason ? { reason } : {}), handoff: `${stage} ${state}${reason ? `: ${reason}` : ""}` }, ...usage };
      };
      // A reload ends this instance mid-loop: the step must not record an outcome, or the run would never pick the stage up again. It stays
      // `running` in the journal, exactly as after a crash, and the next instance runs it again (the stage finds its helper thread by its receipt).
      const interrupted = (): Promise<never> => new Promise<never>(() => undefined);
      try {
        let result: Row = { state: "running" };
        for (let round = 0; round < ROUNDS && !ctx.state.disposed && !c.signal.aborted; round++) {
          result = await call({ threadId, projectId, runId, taskId, timeoutSec: 60, workflow: { runId: c.runId, stepKey: c.stepKey, nodeId: c.nodeId } });
          if (result.state !== "running") break;
        }
        if (ctx.state.disposed) return await interrupted();
        return await done(result);
      } catch (cause) {
        if (ctx.state.disposed) return await interrupted();
        const reason = cause instanceof Error ? cause.message : String(cause);
        bb.log.warn(`Lane Pilot ${stage} after ${taskId} failed: ${reason}`);
        return await done({ state: "failed", reason });
      }
    },
  });

  // Verifies the memory branch finished green; failure fails the graph run (never the task) while keeping the step output.
  engine.register("lp.after-accept.join", {
    reentrant: true,
    run: async (c: StepContext) => {
      const memoryState = text(c.input.with.memory_state);
      const memoryReason = text(c.input.with.memory_reason);
      requireGreen("after_accept", [
        { stage: "memory-maintenance", state: memoryState, reason: memoryReason },
      ]);
      return { output: { memory_state: memoryState } };
    },
  });

  engine.register("lp.memory-maintenance", stageStep("memory-maintenance", (args) => services.runMemoryMaintenance(args)));
}

/**
 * The after-acceptance graph starts once a task landed (the task-finished event emitted at the end of the writer's
 * epilogue, after the receipts and the run refresh — the order kept by that emission point).
 */
export function mountWorkflowAttemptFinished(ctx: ServerCore, services: { onAttemptFinished: OnAttemptFinished; startAfterAcceptance: (projectId: string, runId: string, taskId: string, pmThreadId: string) => void }): void {
  services.onAttemptFinished(ctx, (event) => {
    if (event.scope !== "task" || event.status !== "accepted") return;
    services.startAfterAcceptance(event.projectId, event.runId, event.taskId, event.pmThreadId);
  }, "workflow:after-accept");
}

export function createAfterAcceptStarter(engine: WorkflowEngine, ctx: ServerCore) {
  return function startAfterAcceptance(projectId: string, runId: string, taskId: string, pmThreadId: string): void {
    try {
      const workflow = builtinWorkflow(AFTER_ACCEPT);
      if (!workflow) throw new Error(`built-in workflow ${AFTER_ACCEPT} is not loaded`);
      const started = engine.start({ workflow, inputs: { run_id: runId, task_id: taskId, pm_thread_id: pmThreadId }, key: afterAcceptKey(runId, taskId), link: { projectId, runId, taskId } });
      started.done.catch((cause: unknown) => {
        if (!ctx.state.disposed) ctx.bb.log.warn(`Lane Pilot after-acceptance run of ${taskId} stopped: ${cause instanceof Error ? cause.message : String(cause)}`);
      });
    } catch (cause) {
      if (!ctx.state.disposed) ctx.bb.log.warn(`Lane Pilot could not start the after-acceptance run of ${taskId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };
}
