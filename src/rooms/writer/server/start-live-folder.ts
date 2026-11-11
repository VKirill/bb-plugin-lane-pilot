import { bestEffort } from "@lane-pilot/kit";
import { taskBasePath } from "../../storage";
import { failureClass } from "../../contracts/failure-class";
import type { StartWriterTaskDeps } from "./start-writer-task";
import type { WriterTaskInput, WriterTaskState } from "./start-task-state";

export const dropLiveWriterKey = (deps: StartWriterTaskDeps, state: WriterTaskState) => {
  const { services, admitted } = deps;
  if (!state.holdsLiveWriter) return;
  state.holdsLiveWriter = false;
  admitted.delete(state.key);
  services.activeWriterTasks.delete(state.key);
};

/** The backup an attempt works under, kept so an attempt resumed later (the PM's answer, a reload) finds it. */
export const liveBackupKey = (forAttemptId:string) => `live-backup:${forAttemptId}`;

export const bindLiveBackup = async (deps: StartWriterTaskDeps, state: WriterTaskState):Promise<void> => {
  const { ctx } = deps;
  const { bb } = ctx;
  if (state.liveBackupId) await bestEffort(ctx.log, "writer live backup bind", bb.storage.kv.set(liveBackupKey(state.attemptId), state.liveBackupId as never), undefined);
};

/** Puts the owned files back after a failed attempt and takes out what the writer created there; once per backup. */
export const rollbackLive = async (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput):Promise<void> => {
  const { ctx, services } = deps;
  const { bb, db } = ctx;
  const backupId = state.liveBackupId;
  if (!backupId) return;
  // A writer's question is a pause, not a rejection: its answer continues the same attempt on the files as it left them.
  if (failureClass(String(state.last.status), typeof state.last.reason === "string" ? state.last.reason : null) === "judgment") return;
  state.liveBackupId = null;
  const folder = taskBasePath(db, input.runId, input.taskId) ?? input.task.project_cwd;
  const rolled = await services.restoreLiveFolder({ hostId:input.config.hostId, folder, backupId, task:state.freshTask })
    .catch((cause:unknown) => ({ ok:false as const, reason:cause instanceof Error ? cause.message : String(cause) }));
  if (rolled.ok && !rolled.failed.length) {
    ctx.log(`writer ${input.taskId}: rolled back ${backupId}: ${rolled.restored.length} restored, ${rolled.removed.length} removed`);
    return;
  }
  const why = rolled.ok ? `could not put back ${rolled.failed.join("; ")}` : rolled.reason;
  ctx.log(`writer ${input.taskId}: rollback of ${backupId} incomplete: ${why}`);
  if (input.pmThreadId) void bestEffort(ctx.log, "writer rollback notice", bb.sdk.threads.send({ threadId:input.pmThreadId, mode:"queue-if-active", input:[{ type:"text", mentions:[],
    text:`Lane Pilot: task ${input.taskId} was not accepted and its files in ${folder} could not be put back automatically (${why.slice(0, 600)}). The originals are in ~/.lane-pilot/live-backups/${backupId}/files on the folder's machine; tell the owner before another task runs there.` }] } as never), undefined);
};
