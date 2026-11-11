import { listAttemptsForTask, taskBasePath, type getAttempt } from "../../storage";
import { shouldMergeAttemptWorktree } from "./spawn";
import type { StartWriterTaskDeps } from "./start-writer-task";
import type { WriterTaskInput, WriterTaskState } from "./start-task-state";

/** Gives up the threads of this task's failed attempts: provider-retry's queued retries in them are cancelled (I2). */
export const releaseFailedThreads = async (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput) => {
  const { ctx, services } = deps;
  const { db } = ctx;
  for (const row of listAttemptsForTask(db, input.runId, input.taskId)) {
    if (row.thread_id && row.state !== "accepted") await services.providerRetry.abandon(row.thread_id);
  }
};

/** Removes a failed attempt's own worktree; a worktree that is the run folder, or a BB environment, is left alone. */
export const removeWorktreeOf = async (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput, failed:ReturnType<typeof getAttempt>) => {
  const { ctx, services } = deps;
  const { bb, db, host } = ctx;
  const failedBase=taskBasePath(db, input.runId, input.taskId);
  if(failed?.workspace_path&&failed.environment_id===null&&failedBase&&shouldMergeAttemptWorktree(failed.workspace_path,failedBase)) {
    // The work comes back before the worktree goes (SMA rule 9): its state is on record, it is saved as a patch, and a
    // snapshot that fails keeps the worktree.
    await services.rollback?.noteWorktree({attemptId:failed.id,hostId:input.config.hostId,basePath:failedBase,worktreePath:failed.workspace_path,outcome:`failed:${failed.state}`});
    const removed=await host.call("gitRemoveWorktree",{requestedHostId:input.config.hostId,basePath:failedBase,worktreePath:failed.workspace_path,release:true},
      {hostId:input.config.hostId,timeoutMs:300_000}).catch((cause)=>{ bb.log.warn(`Lane Pilot could not remove worktree of ${failed.id}: ${cause instanceof Error?cause.message:String(cause)}`); return null; });
    services.rollback?.noteSaved(failed.id,removed?.saved);
  }
};
