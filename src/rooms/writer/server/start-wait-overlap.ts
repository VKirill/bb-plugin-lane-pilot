import { taskBasePath, getTask, latestTaskAttemptState, listOpenAttempts, listStageReceipts, listUnansweredWriterQuestions, taskHeldUntil } from "../../storage";
import { taskV2Schema } from "../../contracts";
import { ownsPathsOverlap } from "@lane-pilot/kit";
import { isRunHalted, isRunPaused } from "../../runs/server";
import { recordStage } from "../../runs/server";
import { checkoutOwnsOverlap, dependsOnTask } from "../../tasks";
import { sameArea } from "./start-area";
import type { StartWriterTaskDeps } from "./start-writer-task";
import type { WriterTaskInput, WriterTaskState } from "./start-task-state";

export const waitForOverlappingTasks = async (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput, shouldStop?:()=>string|null) => {
  const { ctx, admitted } = deps;
  const { bb, db } = ctx;
  // Tasks queue behind each other in the same checkout only: another repository of the same folder is another checkout.
  const base = taskBasePath(db, input.runId, input.taskId);
  /** Another task of this folder that ended with a question nobody has answered; a halted run (the owner stopped it) holds nothing. */
  const unansweredQuestionHolder = async () => {
    let haltReadLogged = false;
    for (const row of listUnansweredWriterQuestions(db)) {
      if (row.task_id === input.taskId || row.project_id !== input.projectId) continue;
      if (base && taskBasePath(db, row.run_id, row.task_id) !== base) continue;
      try { if (await isRunHalted(bb.storage.kv as never, row.run_id)) continue; }
      catch (cause) {
        // A failed halt read is "state unknown": count the question as a blocker so the outer poll retries the read.
        if (!haltReadLogged) { haltReadLogged = true; bb.log.warn(`writer ${input.taskId}: run ${row.run_id} halt state unreadable, treating its question as unanswered: ${cause instanceof Error ? cause.message : String(cause)}`); }
      }
      return row;
    }
    return undefined;
  };
  let noted = "";
  for (;;) {
    if (ctx.isDisposed()) return;
    const stop = shouldStop?.();
    if (stop) return stop;
    const open = listOpenAttempts(db);
    const mine = open.findIndex((row) => row.id === state.attemptId);
    if (mine < 0) return;
    const ahead = open.slice(0, mine);
    // A task whose writer already started keeps its files through its redos. A redo is a new attempt row, later than the
    // tasks queued behind the first one, and between two attempts the task has no open row at all: read by row order
    // alone, those tasks started beside the redo and one of the two met a merge_conflict (SelfyStudio 2026-10-14/15:
    // chat-free-muse-trial-api started 12 s after chat-limits-truthful's replay went red, pricing-ladder-v2 likewise).
    for (const held of admitted.values()) {
      if (held.taskId === input.taskId || ahead.some((row) => row.run_id === held.runId && row.task_id === held.taskId)) continue;
      ahead.push(open.find((row) => row.run_id === held.runId && row.task_id === held.taskId)
        ?? { id:`${held.runId}:${held.taskId}`, run_id:held.runId, task_id:held.taskId, thread_id:null, state:"running", project_id:held.projectId });
    }
    // `admitted` lives in memory and a reload empties it: an attempt whose writer is at work holds its files whatever the
    // row order (Vampirism Fire 2026-10-25: after a reload vf-s7-restock started beside vf-s7-minion-aura's running merge
    // turn on the same economy.luau, and both ended merge_conflict).
    for (const row of open.slice(mine + 1)) {
      if (row.state === "running" && row.thread_id && row.task_id !== input.taskId && !ahead.some((held) => held.run_id === row.run_id && held.task_id === row.task_id)) ahead.push(row);
    }
    // A queued task that cannot start by itself holds no one: held until a date (lane_pilot_queue hold) or in a paused run, it
    // only kept its place in the row order, and every later task of its files or area waited for a writer that was not coming.
    const idle = new Set<string>();
    for (const row of ahead) {
      if (row.state !== "queued") continue;
      const heldUntil = taskHeldUntil(db, row.task_id);
      if ((heldUntil !== null && heldUntil > Date.now()) || await isRunPaused(bb.storage.kv as never, row.run_id)) idle.add(row.id);
    }
    const blocker = ahead.find((row) => {
      if (row.task_id === input.taskId || row.project_id !== input.projectId || idle.has(row.id)) return false;
      const rowBase = taskBasePath(db, row.run_id, row.task_id);
      const parsed = taskV2Schema.safeParse(getTask(db,row.task_id)?.contract);
      // A task that depends on this one waits for it anyway; waiting for it back is a deadlock
      // (live 2026-10-03: price-watermark.5 depends_on how.5, how.5 queued behind price-watermark.5).
      if (parsed.success && dependsOnTask(parsed.data.depends_on, input.taskId)) return false;
      // A queued task still waiting for its own depends_on works on nothing yet, so it holds no one: through a
      // chain (A waits on B's area, B depends on C, C on A) it was a deadlock of a whole run (BB-сервис 2026-10-05).
      if (row.state === "queued" && parsed.success && (parsed.data.depends_on ?? [])
        .some((dep) => dep !== row.task_id && latestTaskAttemptState(db, row.project_id, dep) !== "accepted")) return false;
      // A task of a repository inside this folder (or of the folder around this repository) is another checkout: it
      // waits only when the two own the same files, read from the outer folder.
      if (base && rowBase !== base) return Boolean(rowBase && parsed.success && checkoutOwnsOverlap(base, input.task.owns_paths, rowBase, parsed.data.owns_paths));
      // One writer at a time per area: the next task of a page continues in its writer's thread once it is free.
      if (state.liveFolder) return true;
      if (parsed.success && sameArea(parsed.data.area, input.task.area)) return true;
      return parsed.success && ownsPathsOverlap(parsed.data.owns_paths, input.task.owns_paths);
    });
    // A writer's question is a pause, not a release: its files are still in the folder without git, and its answer goes on
    // from them, so no other task may start there until the question is answered (or the task is sent again).
    const asked = !blocker && state.liveFolder ? await unansweredQuestionHolder() : undefined;
    const holder = blocker ?? asked;
    if (!holder) return;
    const why = asked ? "its writer's question is unanswered and the folder has no git, so it stays locked until lane_pilot_answer_writer answers it"
      : state.liveFolder ? "one writer at a time in a folder without git" : "their owns_paths overlap";
    if (noted !== holder.id) {
      noted = holder.id;
      ctx.log(`writer ${input.taskId} waits for ${holder.task_id}: ${why}`);
      const stage = listStageReceipts(db,input.runId,input.taskId).find((row) => row.stageId === "writer-agent");
      if (!stage || stage.state === "pending") {
        recordStage(db, { runId:input.runId, taskId:input.taskId, stageId:"writer-agent", state:"pending", input:input.plan,
          reason:`waiting for ${holder.task_id} (thread ${holder.thread_id ?? "not started"}): ${state.liveFolder ? why : `${input.task.area ? "same area or " : ""}owns_paths overlap`}` });
      }
    }
    await new Promise((wake) => setTimeout(wake, 10_000));
  }
};
