import { taskV2Schema } from "../contracts";
import { getAttempt, getRun, getTask, getTaskPlan, listOpenAttempts, loadPrototypeConfig, setAttemptHolderThread, transitionAttempt } from "../database";
import { reconcile, reconcileHolder } from "../reconcile";
import type { IdempotencyTriple } from "../reconcile";
import { shouldReconcileAttemptThread, shouldResumeWorktreeHolder, shouldScanLostWorktreeHolder } from "../stages/run-policy";
import { WriterSelectionError } from "./run-routing";
import { stringAt } from "./values";
import type { ServerCore } from "./core";
import type { ReconcilePort } from "../reconcile";
import type { Services } from "./services";

export function createReconcile(ctx: ServerCore, services: Services) {
  const { acceptedTaskWorkspace, bb, db, refreshRun } = ctx;

  function threadReconcilePort(projectId:string): ReconcilePort {
    return {
      list: async ({ limit, offset }:{limit:number;offset:number}) => (await bb.sdk.threads.list({
        projectId,
        originPluginId:"lane-pilot",
        includeHidden:true,
        limit,
        offset,
      })).map((thread) => ({ id:thread.id })),
      metadata: async (threadId:string) => bb.sdk.threads.getPluginMetadata({ threadId }),
    };
  }

  async function recoverLostHolderThread(
    projectId:string,
    attempt:NonNullable<ReturnType<typeof getAttempt>>,
  ): Promise<string|null> {
    const result = await reconcileHolder(threadReconcilePort(projectId), {
      lanePilotRunId:attempt.run_id,
      lanePilotTaskId:attempt.task_id,
      workspaceAttemptId:attempt.id,
    });
    if (result.kind === "not_found") return null;
    if (result.kind === "found") {
      if (!setAttemptHolderThread(db, attempt.id, result.threadId)) {
        const persisted = getAttempt(db, attempt.id)?.holder_thread_id;
        if (!persisted || persisted !== result.threadId) throw new WriterSelectionError("attempt_worktree_holder_cas_conflict");
      }
      return result.threadId;
    }
    if (result.kind === "blocked") {
      transitionAttempt(db, attempt.id, "blocked", { reason:`holder_reconcile_${result.reason}` });
      throw new WriterSelectionError(`attempt_worktree_holder_ambiguous:${result.reason}`);
    }
    transitionAttempt(db, attempt.id, "spawn_unknown", { reason:`holder_reconcile_error:${result.message}` });
    throw new WriterSelectionError(`attempt_worktree_holder_reconcile_error:${result.message}`);
  }

  function enqueueResumedWriter(projectId:string, attempt:NonNullable<ReturnType<typeof getAttempt>>, writerThreadId?:string):boolean {
    const run = getRun(db, attempt.run_id);
    const stored = getTask(db, attempt.task_id);
    const config = loadPrototypeConfig(db, projectId);
    const parsed = stored?.kind === "bb" ? taskV2Schema.safeParse(stored.contract) : null;
    if (!run?.writer_workspace_path || !config || !parsed?.success) return false;
    const taskWorkspace=acceptedTaskWorkspace(attempt.run_id,attempt.task_id,run.writer_workspace_path,parsed.data,attempt.id);
    services.startWriterTask({
      projectId, runId:attempt.run_id, taskId:attempt.task_id,
      firstAttemptId:attempt.id, pmThreadId:run.pm_thread_id ?? "", writerThreadId,
      dirtBefore:attempt.dirt_before,
      config:{ ...config, writerWorkspacePath:taskWorkspace.path },
      task:taskWorkspace.task,
      plan:getTaskPlan(db, attempt.task_id) ?? parsed.data.objective,
    });
    return true;
  }

  async function reconcileAttemptThread(
    projectId: string,
    attempt: NonNullable<ReturnType<typeof getAttempt>>,
  ): Promise<string> {
    const key: IdempotencyTriple = {
      lanePilotRunId:attempt.run_id,
      lanePilotTaskId:attempt.task_id,
      attemptId:attempt.id,
    };
    const result = await reconcile(threadReconcilePort(projectId), key);
    if (result.kind === "found") {
      transitionAttempt(db, attempt.id, "running", { threadId:result.threadId });
      return result.threadId;
    }
    if (result.kind === "not_found") {
      transitionAttempt(db, attempt.id, "spawn_rejected", { reason:"reconcile completed on a short page without a matching thread" });
      throw new Error("writer spawn was not created after a complete reconcile scan");
    }
    if (result.kind === "blocked") {
      transitionAttempt(db, attempt.id, "blocked", { reason:`reconcile_${result.reason}` });
      throw new Error(`writer reconcile blocked: ${result.reason}`);
    }
    transitionAttempt(db, attempt.id, "spawn_unknown", { reason:`reconcile_error: ${result.message}` });
    throw new Error(`writer reconcile failed: ${result.message}`);
  }

  async function maybeFinishResumedAttempt(input: {
    projectId:string; attempt:NonNullable<ReturnType<typeof getAttempt>>; writerThreadId:string;
  }): Promise<boolean> {
    if (!input.writerThreadId) return false;
    const thread = await bb.sdk.threads.get({ threadId:input.writerThreadId }).catch(() => null);
    const status = stringAt(thread, "status");
    if (status !== "idle" && status !== "error") return false;
    if (input.attempt.state === "cancel_requested") {
      transitionAttempt(db, input.attempt.id, "canceled", { threadId:input.writerThreadId, reason:"writer stop observed during recovery" });
      refreshRun(input.attempt.run_id);
      return true;
    }
    if (input.attempt.state !== "running") return false;
    const run = getRun(db, input.attempt.run_id);
    const stored = getTask(db, input.attempt.task_id);
    const config = loadPrototypeConfig(db, input.projectId);
    if (!run?.writer_workspace_path || !config || stored?.kind !== "bb") return false;
    const parsed = taskV2Schema.safeParse(stored.contract);
    if (!parsed.success) return false;
    const taskWorkspace=acceptedTaskWorkspace(input.attempt.run_id,input.attempt.task_id,run.writer_workspace_path,parsed.data,input.attempt.id);
    await services.finishWriterAttempt({
      projectId:input.projectId,
      config:{ ...config, writerWorkspacePath:taskWorkspace.path },
      task:taskWorkspace.task,
      runId:input.attempt.run_id,
      taskId:input.attempt.task_id,
      attemptId:input.attempt.id,
      pmThreadId:run.pm_thread_id ?? "",
      writerThreadId:input.writerThreadId,
      dirtBefore:input.attempt.dirt_before,
    });
    refreshRun(input.attempt.run_id);
    return true;
  }

  async function resumeOrphans(projectId?: string): Promise<{ resumed:string[]; skipped:string[]; finished:string[] }> {
    const resumed: string[] = [];
    const skipped: string[] = [];
    const finished: string[] = [];
    for (const row of listOpenAttempts(db)) {
      if (projectId && row.project_id !== projectId) continue;
      const attempt = getAttempt(db, row.id);
      if (!attempt) continue;
      try {
        // A queued attempt has not requested a provider thread yet. Do not feed it
        // through thread reconciliation, which correctly rejects a missing spawn;
        // resume it directly through the persisted run pool after reload.
        if (shouldResumeWorktreeHolder(attempt)) {
          enqueueResumedWriter(row.project_id, attempt);
          resumed.push(row.id);
          continue;
        }
        if (shouldScanLostWorktreeHolder(attempt)) {
          const recovered = await recoverLostHolderThread(row.project_id, attempt);
          if (recovered) {
            enqueueResumedWriter(row.project_id, getAttempt(db, attempt.id) ?? attempt);
            resumed.push(row.id);
            continue;
          }
        }
        const writerThreadId = shouldReconcileAttemptThread(attempt.state, attempt) ? await reconcileAttemptThread(row.project_id, attempt) : "";
        const current = getAttempt(db, row.id);
        if (current && await maybeFinishResumedAttempt({
          projectId:row.project_id, attempt:current, writerThreadId,
        })) {
          finished.push(row.id);
        } else if (current && (current.state === "running" || current.state === "queued")) {
          const run = getRun(db, current.run_id);
          const stored = getTask(db, current.task_id);
          const config = loadPrototypeConfig(db, row.project_id);
          const parsed = stored?.kind === "bb" ? taskV2Schema.safeParse(stored.contract) : null;
          if (run?.writer_workspace_path && config && parsed?.success) {
            const taskWorkspace=acceptedTaskWorkspace(current.run_id,current.task_id,run.writer_workspace_path,parsed.data,current.id);
            services.startWriterTask({
              projectId:row.project_id, runId:current.run_id, taskId:current.task_id,
              firstAttemptId:current.id, pmThreadId:run.pm_thread_id ?? "", writerThreadId,
              dirtBefore:current.dirt_before,
              config:{ ...config, writerWorkspacePath:taskWorkspace.path },
              task:taskWorkspace.task,
              plan:getTaskPlan(db, current.task_id) ?? parsed.data.objective,
            });
          }
        }
        resumed.push(row.id);
      } catch {
        skipped.push(row.id);
      }
    }
    return { resumed, skipped, finished };
  }

  return { threadReconcilePort, recoverLostHolderThread, enqueueResumedWriter, reconcileAttemptThread, maybeFinishResumedAttempt, resumeOrphans };
}
