import { getRun, listOpenAttempts, listStageReceipts } from "../../storage";
import { shouldTriggerProjectLife } from "../../project-life";
import { withUsage } from "../../usage/server";
import { AFTER_ACCEPT, builtinWorkflow } from "../builtin";
import { requireGreen } from "./require-green";
import type { NodeExecutor, StepContext, WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../../core/server";
import type { Services } from "../../core/server";

/**
 * The graph `lp.after-accept` (workflows/lp.after-accept.json): once a task is accepted, the memory maintainer and the project-life
 * maintainer run side by side as two steps of one graph run. Each step wraps the stage function the PM tools already used
 * (`runMemoryMaintenance`, `runProjectLifeMaintenance`); the stage receipts are the same. A stage that cannot be done never stops the other
 * one and is recorded in its receipt and in the step's output; the join then fails the run, so the graph is red when its work is red.
 * The accepted task is never touched either way.
 */

/** The idempotency key of a task's run: a second merge event for the same task finds the first run. */
export const afterAcceptKey = (runId: string, taskId: string): string => `after-accept:${runId}:${taskId}`;

/** Rounds of a minute each the step watches its stage's helper thread, as the fire-and-forget loop did. */
const ROUNDS = 60;

type Stage = "memory-maintenance" | "project-life";
type Row = Record<string, unknown>;
const text = (value: unknown): string => (typeof value === "string" ? value : "");

export function registerAfterAcceptExecutors(engine: WorkflowEngine, ctx: ServerCore, services: Services): void {
  const { bb, db } = ctx;

  /**
   * One stage as one step. `skipped` gives the reason the stage need not run (nothing is recorded then); otherwise the stage function
   * is called until its receipt is final. The helper thread it spawned is read for what it spent and the engine adds that to the run.
   */
  const stageStep = (stage: Stage, skipped: ((args: { projectId: string; runId: string }) => Promise<string | null>) | null, call: (args: { threadId: string; projectId: string; runId: string; taskId: string; timeoutSec: number; workflow: { runId: string; stepKey: string; nodeId: string } }) => Promise<Row>): NodeExecutor => ({
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
        const why = skipped ? await skipped({ projectId, runId }) : null;
        if (why) return await done({ state: "skipped", reason: why });
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

  // The join hands each stage's state on under its own name: the branches' rows merge into one.
  // A stage that failed, was blocked or never finished fails the run (not the task): the output of both stays in their steps.
  engine.register("lp.after-accept.join", {
    reentrant: true,
    run: async (c: StepContext) => {
      const { memory_reason, life_reason, ...output } = Object.assign({}, ...((c.input.with.results as Row[] | undefined) ?? [])) as Row;
      requireGreen("after_accept", [
        { stage: "memory-maintenance", state: text(output.memory_state), reason: text(memory_reason) },
        { stage: "project-life", state: text(output.life_state), reason: text(life_reason) },
      ]);
      return { output };
    },
  });

  engine.register("lp.memory-maintenance", stageStep("memory-maintenance", null, (args) => services.runMemoryMaintenance(args)));

  engine.register("lp.project-life", stageStep("project-life", async ({ projectId, runId }) => {
    // Project life runs once the wave goes idle, and commits PROGRESS and plans to main: a folder without git has no main.
    if (!shouldTriggerProjectLife(listOpenAttempts(db).map((attempt) => attempt.run_id), runId)) return "wave_not_idle";
    const run = getRun(db, runId);
    const config = await ctx.configForRun(projectId, run);
    if (run?.writer_workspace_path && config && await services.isLiveFolder(runId, config.hostId, run.writer_workspace_path)) return "live_folder";
    return null;
  }, (args) => services.runProjectLifeMaintenance(args)));
}

/**
 * Starts the after-acceptance run of an accepted task: the one call site of the merge (verification and the writer's finish). The run is
 * keyed by the task, so a second event for the same task (a merge intent found after the writer's own finish) starts nothing new.
 * Never throws and never waits: a refusal of the engine is logged, the task stays accepted.
 */
export function createAfterAcceptStarter(engine: WorkflowEngine, ctx: ServerCore) {
  return function startAfterAcceptance(projectId: string, runId: string, taskId: string, pmThreadId: string): void {
    try {
      const workflow = builtinWorkflow(AFTER_ACCEPT);
      if (!workflow) throw new Error(`built-in workflow ${AFTER_ACCEPT} is not loaded`);
      const started = engine.start({ workflow, inputs: { run_id: runId, task_id: taskId, pm_thread_id: pmThreadId }, key: afterAcceptKey(runId, taskId), link: { projectId, runId, taskId } });
      started.done.catch((cause: unknown) => {
        if (!ctx.state.disposed) ctx.bb.log.warn(`Lane Pilot after-acceptance run of ${taskId} stopped: ${cause instanceof Error ? cause.message : String(cause)}`);
      });
      // The task's own pipeline waits on its writer step until a poll sees the attempt end; the browser check (qa_cases, qa_url) is the step after it, so do not wait for the five-minute tick.
      void engine.poll().catch((cause: unknown) => {
        if (!ctx.state.disposed) ctx.bb.log.warn(`Lane Pilot could not settle the pipeline of ${taskId}: ${cause instanceof Error ? cause.message : String(cause)}`);
      });
    } catch (cause) {
      if (!ctx.state.disposed) ctx.bb.log.warn(`Lane Pilot could not start the after-acceptance run of ${taskId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };
}
