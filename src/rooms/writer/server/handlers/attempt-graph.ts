import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { LP_EVENTS, isTerminalAttemptState } from "@lane-pilot/contracts";
import { id } from "@lane-pilot/kit";
import { rotatedWriterSettings } from "@lane-pilot/models";
import { wfRunLinkOf } from "@lane-pilot/workflow-engine";
import type { TaskV2 } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import { DISPATCH_STAGES_PENDING } from "../../../runs";
import { closeWriterStages } from "../../../runs/server";
import {
  countAttempts, createAttempt, getAttempt, getRun, getRunSettingsScopes, getTask,
  getTaskPlan, listAttemptsForTask, listStageReceipts, loadProjectSettings, loadPrototypeConfig, transitionAttempt,
} from "../../../storage";
import type { StepContext, WorkflowEngine } from "../../../workflow";
import { evaluateAttemptAdmission, releaseAttemptAdmission, type AdmissionServices } from "../services/attempt-admission";
import { emitAttemptEvent } from "../services/attempt-events";
import { registerAttemptStepExecutors } from "./attempt-graph-steps";
import { registerAttemptSpawnExecutor } from "./attempt-spawn";
import { resolveWriterFallbackPlan } from "../services/attempt-turn-watch";
import { buildQueuedReply, type DispatchRuntime } from "../services/dispatch-runtime";

type Step = StepContext<DispatchRuntime>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Reconstructs `DispatchRuntime` from SQLite after a hub restart if `ctx.runtime` is absent. */
export function createDispatchRuntimeResolver(
  engine: WorkflowEngine,
  bb: BbPluginApi | undefined,
  getBound: () => { ctx?: ServerCore; services: DispatchRuntime["services"] } | undefined,
): (ctx: Step) => Promise<DispatchRuntime> {
  return async (ctx) => {
    if (ctx.runtime) return ctx.runtime;
    const db = engine.journal.db as unknown as ServerCore["db"];
    const runRow = wfRunLinkOf(db, ctx.runId);
    const linkRunId = runRow?.link_run_id ?? "";
    const linkTaskId = runRow?.link_task_id ?? str(ctx.inputs?.taskId) ?? "";
    const linkAttemptId = runRow?.link_attempt_id ?? str(ctx.inputs?.attemptId) ?? "";
    if (!bb || !linkRunId || !linkTaskId) throw new Error("the dispatch was interrupted by a plugin reload; send the task again");
    const run = getRun(db, linkRunId);
    const taskRow = getTask(db, linkTaskId);
    const projectId = run?.project_id ?? runRow?.project_id ?? "";
    const cfg = loadPrototypeConfig(db, projectId);
    if (!run || !taskRow || !cfg) throw new Error("the dispatch was interrupted by a plugin reload; send the task again");
    const bound = getBound();
    const serverCtx = bound?.ctx ?? ({ bb, db, configForRun: async () => cfg, log: (m: string) => bb.log.info(m), refreshRun: () => undefined, isDisposed: () => false } as unknown as ServerCore);
    return {
      ctx: serverCtx,
      services: bound?.services ?? ({} as DispatchRuntime["services"]),
      threadId: run.pm_thread_id ?? "",
      projectId,
      ...(typeof ctx.inputs?.baseRef === "string" ? { baseRef: ctx.inputs.baseRef } : {}),
      runId: linkRunId,
      taskId: linkTaskId,
      attemptId: linkAttemptId,
      config: cfg,
      runConfig: cfg,
      workspacePath: run.writer_workspace_path ?? cfg.writerWorkspacePath,
      task: taskRow.contract as TaskV2,
      plan: getTaskPlan(db, linkTaskId) ?? "",
      lintWarnings: [],
    };
  };
}

/**
 * Registers the event-driven attempt graph executors (`admission` -> `writer` (`lp.attempt-spawn`) ->
 * `wait-turn` -> `turn-outcome` -> `validate` -> `critique` -> `merge`) used by `workflows/lp-task-pipeline.json`.
 */
export function registerAttemptGraphExecutors(
  engine: WorkflowEngine,
  resolveRuntime: (ctx: Step) => Promise<DispatchRuntime>,
): void {
  engine.register<DispatchRuntime>("lp.attempt-admission", {
    run: async (ctx) => {
      const r = await resolveRuntime(ctx);
      if (ctx.input.with.live === true) r.live = true;
      if (!r.live && typeof (r.services as { isLiveFolder?: (runId: string, hostId: string, path: string) => Promise<boolean> }).isLiveFolder === "function") {
        if (await r.services.isLiveFolder(r.runId, r.config.hostId, r.workspacePath).catch(() => false)) r.live = true;
      }
      const pmRead = str(ctx.input.with.pmReadContext);
      if (pmRead !== undefined) r.pmReadContext = pmRead;
      const baselineState = str(ctx.input.with.baselineState);
      const latestRow = listAttemptsForTask(r.ctx.db, r.runId, r.taskId).at(-1);
      if (latestRow && latestRow.id !== r.attemptId) {
        r.attemptId = latestRow.id;
      }
      const current = getAttempt(r.ctx.db, r.attemptId);
      const priorAttemptId = str(ctx.input.with.attemptId) ?? r.attemptId;
      let targetAttemptId = r.attemptId;
      let retryExhausted = false;
      if (current && current.state === "canceled") {
        // An explicit cancel (including on an injected retry attempt) closes the run without creating a new attempt.
        const reason = current.reason ?? "canceled";
        closeWriterStages(r.ctx.db, { runId: r.runId, taskId: r.taskId, plan: r.plan, terminal: "canceled", attempt: countAttempts(r.ctx.db, r.runId, r.taskId), reason });
        r.ctx.refreshRun?.(r.runId);
        await releaseAttemptAdmission(r.ctx.bb.storage?.kv as never, targetAttemptId);
        await emitAttemptEvent({ db: r.ctx.db, engine, name: LP_EVENTS.TASK_SETTLED, key: r.taskId, payload: { attemptId: targetAttemptId, taskId: r.taskId, state: "canceled", reason }, projectId: r.projectId });
        return {
          output: {
            status: "blocked",
            attemptId: targetAttemptId,
            reply: { runId: r.runId, taskId: r.taskId, attemptId: targetAttemptId, state: "canceled", retryable: false, reason, stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) },
          },
        };
      }
      const hasFullAdmission = typeof (r.services as { runBudgetFor?: unknown }).runBudgetFor === "function";
      let admissionUseFallback = false;
      if (current && current.state !== "queued" && current.state !== "accepted" && current.state !== "cancel_requested" && current.state !== "running" && current.state !== "spawn_requested") {
        if (current.state === "provider_error" && r.primaryFailure?.attemptId !== targetAttemptId) {
          r.providerErrorRetries = (r.providerErrorRetries ?? 0) + 1;
          r.primaryFailure = { status: "provider_error", reason: current.reason ?? "provider_error", attemptId: targetAttemptId };
        }
        if (current.state === "provider_error" && !hasFullAdmission) {
          transitionAttempt(r.ctx.db, targetAttemptId, "queued", { reason: current.reason ?? "provider_error retry" });
        } else {
          if (current.state === "provider_error" && hasFullAdmission) {
            const scopes = getRunSettingsScopes(r.ctx.db, r.runId);
            const runSettings = rotatedWriterSettings(loadProjectSettings(r.ctx.db, r.projectId, scopes), r.taskId);
            const { useFallback } = resolveWriterFallbackPlan(runSettings, r.runConfig, current.reason, r.providerErrorRetries ?? 0, current.state);
            admissionUseFallback = useFallback;
            if (useFallback) {
              transitionAttempt(r.ctx.db, targetAttemptId, "blocked", { reason: current.reason ?? "provider_error" });
            }
          }
          // Previous attempt blocked / validation_failed / spawn_rejected / full-service provider_error: create next retry attempt up to 3 primary visits.
          const latest = countAttempts(r.ctx.db, r.runId, r.taskId);
          if (latest < 3) {
            targetAttemptId = id("att");
            createAttempt(r.ctx.db, { id: targetAttemptId, runId: r.runId, taskId: r.taskId });
            r.attemptId = targetAttemptId;
          } else {
            retryExhausted = true;
          }
        }
      } else if (priorAttemptId !== targetAttemptId) {
        r.attemptId = priorAttemptId;
      }

      if (!admissionUseFallback && r.primaryFailure && hasFullAdmission) {
        const scopes = getRunSettingsScopes(r.ctx.db, r.runId);
        const runSettings = rotatedWriterSettings(loadProjectSettings(r.ctx.db, r.projectId, scopes), r.taskId);
        admissionUseFallback = resolveWriterFallbackPlan(runSettings, r.runConfig, r.primaryFailure.reason ?? null, r.providerErrorRetries ?? 0, r.primaryFailure.status).useFallback;
      }

      if (retryExhausted) {
        return { output: { status: "admitted", attemptId: targetAttemptId } };
      }

      if (current?.state === "queued" && current.reason === DISPATCH_STAGES_PENDING) {
        transitionAttempt(r.ctx.db, targetAttemptId, "queued", { reason: null as never });
      }

      const res = await evaluateAttemptAdmission({
        ctx: r.ctx,
        services: r.services as unknown as AdmissionServices,
        projectId: r.projectId,
        runId: r.runId,
        taskId: r.taskId,
        attemptId: targetAttemptId,
        task: r.task,
        config: r.runConfig,
        baselineState,
        liveFolder: r.live === true,
        useFallback: admissionUseFallback,
        now: engine.now(),
      });

      if (res.status === "already_done") {
        const cur = getAttempt(r.ctx.db, targetAttemptId);
        if (cur && cur.state === "queued") transitionAttempt(r.ctx.db, targetAttemptId, "accepted");
        r.ctx.refreshRun?.(r.runId);
        await emitAttemptEvent({ db: r.ctx.db, engine, name: LP_EVENTS.TASK_SETTLED, key: r.taskId, payload: { attemptId: targetAttemptId, taskId: r.taskId, state: "accepted", reason: res.reason }, projectId: r.projectId });
        return {
          output: {
            status: "already_done",
            attemptId: targetAttemptId,
            reply: { runId: r.runId, taskId: r.taskId, attemptId: targetAttemptId, state: "accepted", reason: res.reason, stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) },
          },
        };
      }
      if (res.status === "blocked") {
        const cur = getAttempt(r.ctx.db, targetAttemptId);
        if (cur && !isTerminalAttemptState(cur.state)) transitionAttempt(r.ctx.db, targetAttemptId, "blocked", { reason: res.reason });
        const terminalState = getAttempt(r.ctx.db, targetAttemptId)?.state === "canceled" ? "canceled" : "blocked";
        closeWriterStages(r.ctx.db, { runId: r.runId, taskId: r.taskId, plan: r.plan, terminal: terminalState === "canceled" ? "canceled" : "failed", attempt: countAttempts(r.ctx.db, r.runId, r.taskId), reason: res.reason });
        r.ctx.refreshRun?.(r.runId);
        await releaseAttemptAdmission(r.ctx.bb.storage?.kv as never, targetAttemptId);
        await emitAttemptEvent({ db: r.ctx.db, engine, name: LP_EVENTS.TASK_SETTLED, key: r.taskId, payload: { attemptId: targetAttemptId, taskId: r.taskId, state: terminalState, reason: res.reason }, projectId: r.projectId });
        return {
          output: {
            status: "blocked",
            attemptId: targetAttemptId,
            reply: { runId: r.runId, taskId: r.taskId, attemptId: targetAttemptId, state: terminalState, retryable: false, reason: res.reason, stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) },
          },
        };
      }
      if (res.status === "wait") {
        r.queuedReply = buildQueuedReply(r, null);
        return { output: { status: "wait", attemptId: targetAttemptId, event: res.event, eventKey: r.projectId, waitUntil: res.waitUntil, durationSec: res.durationSec, waitReason: res.waitReason } };
      }
      r.queuedReply = buildQueuedReply(r, null);
      return { output: { status: "admitted", attemptId: targetAttemptId } };
    },
  });

  registerAttemptSpawnExecutor(engine, resolveRuntime);
  registerAttemptStepExecutors(engine, resolveRuntime);
}
