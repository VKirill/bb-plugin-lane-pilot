import { DISPATCH_STAGES_PENDING } from "../../runs";
import { taskV2Schema } from "../../contracts";
import { countAttempts, endSpawnFailure, getAttempt, getRun, getTask, getTaskPlan, listOpenAttempts, setAttemptHolderThread, transitionAttempt } from "../../storage";
import { closeHelperStages, closeWriterStages } from "../../runs/server/stage-records";
import { reconcile, reconcileHolder } from "../reconcile";
import type { IdempotencyTriple } from "../reconcile";
import { shouldReconcileAttemptThread, shouldResumeWorktreeHolder, shouldScanLostWorktreeHolder } from "../../tasks";
import { WriterSelectionError } from "../../runs/server/run-routing";
import { holderSpawnKey, stringAt } from "../../core/server";
import { findThreadsByMetadata } from "../../core/server";
import type { ServerCore } from "../../core/server";
import type { ReconcilePort } from "../reconcile";
import type { Services } from "../../core/server";

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
      endSpawnFailure(db, attempt.id, `${spawnError}reconcile completed on a short page without a matching thread`);
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
      await services.rollback?.noteStopped(input.attempt.id).catch(() => undefined);
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
    // The writer's turn ended while the plugin reloaded: the start loop checks it, as for a turn the PM's answer reopened.
    // Finished here, a failure of the writer's own was retried by a fresh writer from main, in a new thread and without the
    // reason: Vampirism Fire vf-s4-items (2026-10-24, a reload at 12:42) failed «owns_paths rejected …/Items/Use/Buffs.luau»,
    // its retry rewrote Buffs.luau again, and the task ended «retry limit 2 exhausted». The loop redoes it in the same thread
    // with the reason, and closes the stages, the limits and the area record as for any turn.
    services.startWriterTask({
      projectId:input.projectId, runId:input.attempt.run_id, taskId:input.attempt.task_id,
      firstAttemptId:input.attempt.id, pmThreadId:run.pm_thread_id ?? "", writerThreadId:input.writerThreadId,
      dirtBefore:input.attempt.dirt_before,
      config:{ ...config, writerWorkspacePath:taskWorkspace.path },
      task:taskWorkspace.task,
      plan:getTaskPlan(db, input.attempt.task_id) ?? parsed.data.objective,
      turnSent:true,
    });
    return true;
  }

  /**
   * A cancel a reload cut off while its writer still works: the stop is sent again and the cancel ends once the stop is seen, as
   * cancelAttemptById ends it (2026-10-29 audit A-006: recovery listed the attempt as resumed with no stop and no watcher).
   */
  async function finishCancel(attemptId:string, runId:string, threadId:string): Promise<void> {
    try {
      await bb.sdk.threads.stop({ threadId });
      if (!await stopSeen(threadId) || ctx.isDisposed()) return;
      await services.rollback?.noteStopped(attemptId).catch(() => undefined);
      if (getAttempt(db, attemptId)?.state !== "cancel_requested") return;
      transitionAttempt(db, attemptId, "canceled", { threadId, reason:"writer stop observed during recovery" });
      refreshRun(runId);
    } catch (cause) {
      ctx.log(`recovery could not finish the cancel of ${attemptId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  /** The bounded wait of runs/server/writer-stop.ts: the runs room imports this one, so it is not imported back. */
  async function stopSeen(threadId:string): Promise<boolean> {
    const listRunning = (bb.sdk.threads as { listRunning?: (query?: Record<string, unknown>) => Promise<Array<{ id: string }>> }).listRunning;
    for (const deadline = Date.now() + 30_000;;) {
      const status = stringAt(await bb.sdk.threads.get({ threadId }), "status");
      const running = listRunning ? await listRunning({}) : [];
      if (status !== "active" && status !== "running" && !running.some((thread) => thread.id === threadId)) return true;
      if (Date.now() >= deadline || ctx.isDisposed()) return false;
      await new Promise((wake) => setTimeout(wake, 1_000));
    }
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
        // Its stages start again for the same attempt; only one that cannot (see resumeDispatch) is blocked for the PM.
        if (attempt.state === "queued" && !attempt.thread_id && attempt.reason === DISPATCH_STAGES_PENDING) {
          const again = await services.resumeDispatch(attempt.id);
          if (again.resumed) {
            resumed.push(row.id);
            continue;
          }
          const reason = `dispatch interrupted by a reload before pm-read and plan critique finished (${again.why}); send the task again`;
          transitionAttempt(db, attempt.id, "blocked", { reason });
          // The dispatch that waited for its helpers died too: nobody else records their end, and pm-read stayed
          // «running» for good (SelfyStudio, 2026-10-12/13). Its helper threads would only work for nobody.
          const plan = getTaskPlan(db, attempt.task_id) ?? "";
          await closeHelperStages(db, (threadId) => bb.sdk.threads.stop({ threadId }), { runId:attempt.run_id, taskId:attempt.task_id, plan,
            attempt:attempt.attempt_no, state:"blocked", reason });
          closeWriterStages(db, { runId:attempt.run_id, taskId:attempt.task_id, plan, terminal:"failed",
            attempt:countAttempts(db, attempt.run_id, attempt.task_id), reason });
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
              // A running attempt with a writer thread has its turn in that thread: the writer works through the reload, so
              // the start loop must not queue it again behind tasks that were waiting for it (Vampirism Fire 2026-10-25:
              // vf-s7-minion-aura and vf-s7-restock waited 50–100 minutes «for owns_paths» with their writers long idle).
              ...(current.state === "running" && writerThreadId ? { turnSent:true } : {}),
            });
          }
        } else if (current?.state === "cancel_requested" && writerThreadId) {
          void finishCancel(current.id, current.run_id, writerThreadId);
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
