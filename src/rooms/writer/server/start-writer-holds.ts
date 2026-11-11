import { parkAttemptWake, transitionAttempt } from "../../storage";
import { closeOwnerItem, postOwnerItem } from "../../owner-waiting";
import { recordStage } from "../../runs/server";
import { coreHostsRequiredProvider } from "../../runs/server";
import { waitingWriterReason, waitingWriterText, type ChainWalk } from "./writer-hold";
import { noteUnsupportedProvider, noteWriterWait } from "./writer-wake";
import type { StartWriterTaskDeps } from "./start-writer-task";
import type { WriterTaskInput, WriterTaskState } from "./start-task-state";

// H2: the spawn gate's availability sources (breaker, owner presence, core allowlist, usage window) answer
// before an attempt is spent on a writer that cannot start (writer-hold.ts).
export const writerHoldDeps = (deps: StartWriterTaskDeps) => {
  const { ctx, services } = deps;
  const { bb } = ctx;
  return { breaker:services.providerBreaker, presence:services.ownerPresence, usage:services.providerUsage, money:services.money,
    coreHosts:(providerId:string) => coreHostsRequiredProvider(bb, providerId), log:ctx.log };
};

/**
 * Every writer of the chain is held: the attempt stays `queued` with `waiting_writer:` + wake_at, the board
 * line says what it waits for, and the PM hears it once per attempt. A chain of nothing but
 * `core_unsupported` ends blocked as before, and the owner hears once per provider, not per task.
 * Returns true when the caller must stop here (the attempt is parked or blocked).
 */
export const parkForWriter = async (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput, forAttemptId:string, walk:ChainWalk):Promise<boolean> => {
  const { ctx } = deps;
  const { db } = ctx;
  // The owner's own list (writer.models_off) emptied the chain: not an unsupported provider. The task waits and re-checks, one owner item says how to clear the list, and a start that succeeds closes it.
  const offItemKey = `writer-all-off:${input.projectId}`;
  if (walk.free) { closeOwnerItem(db, offItemKey, "janitor:writer-started"); return false; }
  if (walk.allOff) postOwnerItem(db, { key:offItemKey, source:"writer", kind:"writer_off", projectId:input.projectId, wake:true,
    what:`Все писатели проекта ${input.projectId} выключены списком writer.models_off: ${walk.off.join(", ")}`,
    why:`Задача ${input.taskId} ждёт и сама начнётся, когда список очистят. Очистить: bb lane-pilot setting ${input.projectId} writer.models_off=`,
    actions:[{ id:"clear", label:"Очистить writer.models_off", cli:`bb lane-pilot setting ${input.projectId} writer.models_off=` }] });
  if (walk.allUnsupported) {
    const reason = walk.shortest?.hold.reason ?? "writer_provider_unavailable:core_unsupported";
    transitionAttempt(db, forAttemptId, "blocked", { reason });
    for (const held of walk.holds) void noteUnsupportedProvider(ctx, { providerId:held.member.providerId, pmThreadId:input.pmThreadId, taskId:input.taskId });
    state.last = { status:"blocked", reason, attemptId:forAttemptId };
    return true;
  }
  const held = walk.shortest!.hold;
  const reason = waitingWriterReason(held);
  const text = waitingWriterText(held, walk.wakeAt);
  parkAttemptWake(db, forAttemptId, reason, walk.wakeAt);
  recordStage(db, { runId:input.runId, taskId:input.taskId, stageId:"writer-agent", state:"pending", input:input.plan, reason:text });
  void noteWriterWait(ctx, { attemptId:forAttemptId, pmThreadId:input.pmThreadId, taskId:input.taskId, text });
  ctx.log(`writer ${input.taskId}: every writer is held (${held.reason}); the attempt waits until ${walk.wakeAt ? new Date(walk.wakeAt).toISOString() : "unknown"}`);
  state.last = { status:"queued", reason, attemptId:forAttemptId };
  return true;
};
