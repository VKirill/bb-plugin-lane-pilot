import { DISPATCH_STAGES_PENDING } from "../constants";
import { taskV2Schema } from "../contracts";
import { countAttempts, countChargedAttempts, createAttempt, getAttempt, getRun, getTask, getTaskPlan, listOpenAttempts, setAttemptHolderThread, transitionAttempt } from "../database";
import { closeWriterStages } from "./stage-records";
import { FREE_RETRY_LIMIT } from "../failure-class";
import { MAIN_ATTEMPT_LIMIT, RETRY_ELIGIBLE, type AttemptState } from "../state-machine";
import { randomUUID } from "node:crypto";
import { reconcile, reconcileHolder } from "../reconcile";
import type { IdempotencyTriple } from "../reconcile";
import { shouldReconcileAttemptThread, shouldResumeWorktreeHolder, shouldScanLostWorktreeHolder } from "../stages/run-policy";
import { WriterSelectionError } from "./run-routing";
import { holderSpawnKey, stringAt } from "./values";
import { findThreadsByMetadata } from "./thread-keys";
import type { ServerCore } from "./core";
import type { ReconcilePort } from "../reconcile";
import type { Services } from "./services";

export function createReconcile(ctx: ServerCore, services: Services) {
  const { acceptedTaskWorkspace, bb, configForRun, db, refreshRun } = ctx;

  function threadReconcilePort(projectId:string): ReconcilePort {
    return {
      list: async ({ limit, offset }:{limit:number;offset:number}) => (await bb.sdk.threads.list({
        projectId,
        originPluginId:"lane-pilot",
        includeHidden:true,
        archived:false,
        limit,
        offset,
      })).map((thread) => ({ id:thread.id })),
      metadata: async (threadId:string) => bb.sdk.threads.getPluginMetadata({ threadId }),
      find: (match) => findThreadsByMetadata(bb, match, projectId),
    };
  }

  async function recoverLostHolderThread(
    projectId:string,
    attempt:NonNullable<ReturnType<typeof getAttempt>>,
  ): Promise<string|null> {
    // Only an attempt that began spawning a holder can have lost one. Scanning for every fresh attempt read the
    // metadata of every thread of the project: a minute per dispatch on SelfyStudio (1000+ threads), then
    // attempt_worktree_holder_ambiguous:page_cap for every task once the project passed 1000 (live 2026-10-04).
    if (!await bb.storage.kv.get(holderSpawnKey(attempt.id)).catch(() => null)) return null;
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

  // A native (cli) run takes its host, folder and writer from configForRun; the prototype config exists on a few
  // old projects only, so reading it here left every other project's writers hanging after a reload.
  async function enqueueResumedWriter(projectId:string, attempt:NonNullable<ReturnType<typeof getAttempt>>, writerThreadId?:string):Promise<boolean> {
    const run = getRun(db, attempt.run_id);
    const stored = getTask(db, attempt.task_id);
    const config = await configForRun(projectId, run);
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
      // A stop requested before the reload stays requested: the attempt goes on to «canceled», not back to «running».
      if (attempt.state !== "cancel_requested") transitionAttempt(db, attempt.id, "running", { threadId:result.threadId });
      return result.threadId;
    }
    if (result.kind === "not_found") {
      // Keep the spawn error that sent us here: alone, the reconcile outcome hid helper_parent_relation_missing for days.
      const spawnError = attempt.state === "spawn_unknown" && attempt.reason ? `spawn failed: ${attempt.reason}; ` : "";
      transitionAttempt(db, attempt.id, "spawn_rejected", { reason:`${spawnError}reconcile completed on a short page without a matching thread` });
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
    const config = await configForRun(input.projectId, run);
    if (!run?.writer_workspace_path || !config || stored?.kind !== "bb") return false;
    const parsed = taskV2Schema.safeParse(stored.contract);
    if (!parsed.success) return false;
    const taskWorkspace=acceptedTaskWorkspace(input.attempt.run_id,input.attempt.task_id,run.writer_workspace_path,parsed.data,input.attempt.id);
    const last = await services.finishWriterAttempt({
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
    // The start loop that would close the stages or retry died with the reload; do its ending here.
    const outcome = String(last.status);
    const plan = getTaskPlan(db, input.attempt.task_id) ?? parsed.data.objective;
    const attempts = countAttempts(db, input.attempt.run_id, input.attempt.task_id);
    const close = (terminal:"passed"|"failed"|"canceled", reason?:string) => closeWriterStages(db, { runId:input.attempt.run_id, taskId:input.attempt.task_id,
      plan, terminal, attempt:attempts, reason, threadId:input.writerThreadId, result:last });
    if (outcome === "accepted") {
      close("passed");
      services.maintainMemoryAfterAcceptance(input.projectId, input.attempt.run_id, input.attempt.task_id, run.pm_thread_id ?? "");
      services.maintainProjectLifeAfterAcceptance(input.projectId, input.attempt.run_id, input.attempt.task_id, run.pm_thread_id ?? "");
    } else if (outcome === "canceled") {
      close("canceled", "writer attempt canceled");
    } else if (RETRY_ELIGIBLE.includes(outcome as AttemptState) && countChargedAttempts(db, input.attempt.run_id, input.attempt.task_id) < MAIN_ATTEMPT_LIMIT
      && attempts < MAIN_ATTEMPT_LIMIT + FREE_RETRY_LIMIT && run.pm_thread_id) {
      const retryId = `lpattempt_${randomUUID().replaceAll("-", "")}`;
      createAttempt(db, { id:retryId, runId:input.attempt.run_id, taskId:input.attempt.task_id });
      const fresh = acceptedTaskWorkspace(input.attempt.run_id, input.attempt.task_id, run.writer_workspace_path, parsed.data);
      services.startWriterTask({ projectId:input.projectId, runId:input.attempt.run_id, taskId:input.attempt.task_id, firstAttemptId:retryId,
        pmThreadId:run.pm_thread_id, config:{ ...config, writerWorkspacePath:fresh.path }, task:fresh.task, plan });
    } else {
      const reason = `${RETRY_ELIGIBLE.includes(outcome as AttemptState) ? `retry limit ${MAIN_ATTEMPT_LIMIT} exhausted: ` : ""}${String(last.reason ?? outcome)}`;
      if (getAttempt(db, input.attempt.id)?.state !== "blocked") transitionAttempt(db, input.attempt.id, "blocked", { reason });
      close("failed", reason);
    }
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
        // A dispatch whose pm-read / plan critique died with the reload never passed its gate: the writer must not start.
        if (attempt.state === "queued" && !attempt.thread_id && attempt.reason === DISPATCH_STAGES_PENDING) {
          transitionAttempt(db, attempt.id, "blocked", { reason:"dispatch interrupted by a reload before pm-read and plan critique finished; send the task again" });
          refreshRun(attempt.run_id);
          skipped.push(row.id);
          continue;
        }
        // A queued attempt has not requested a provider thread yet. Do not feed it
        // through thread reconciliation, which correctly rejects a missing spawn;
        // resume it directly through the persisted run pool after reload.
        if (shouldResumeWorktreeHolder(attempt)) {
          await enqueueResumedWriter(row.project_id, attempt);
          resumed.push(row.id);
          continue;
        }
        if (shouldScanLostWorktreeHolder(attempt)) {
          const recovered = await recoverLostHolderThread(row.project_id, attempt);
          if (recovered) {
            await enqueueResumedWriter(row.project_id, getAttempt(db, attempt.id) ?? attempt);
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
          const config = await configForRun(row.project_id, run);
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
