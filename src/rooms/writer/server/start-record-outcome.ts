import { countAttempts, countThreadTurns, listStageReceipts, noteToldPmDirectly } from "../../storage";
import { bestEffort } from "@lane-pilot/kit";
;
import { MAIN_ATTEMPT_LIMIT } from "../../contracts";
import { WRITER_QUESTION_WAIT_TEXT } from "./question-default";
import { failureClass } from "../../contracts";


import { type WriterTaskState } from "./start-task-state";
import { rollbackLive } from "./start-live-folder";
import { releaseFailedThreads, removeWorktreeOf } from "./start-failed-cleanup";

import { recordStage } from "../../runs/server";
import { id } from "@lane-pilot/kit";

import { sendServiceMessage } from "../../relay/server";
import { emitAttemptFinished } from "./attempt-finished";

import type { StartWriterTaskDeps } from "./start-writer-task";
import type { WriterTaskInput } from "./start-task-state";

      /** The task's end for these writers: worktree and live-folder cleanup, the terminal receipts, the reactions. */
      export const recordOutcome = async (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput):Promise<void> => {
      const { ctx, services, noteAttemptOutcome } = deps;
      const { bb, db, refreshRun } = ctx;
      // A worktree kept for a fallback that did not continue in it (no chain, a guard stopped it) is removed as any failed one.
      // A writer's question keeps its worktree: the answer continues there. Removing it here also hung the live-writer
      // key (the sweep then skipped the question) when the host call did not return.
      const asked = failureClass(String(state.last.status), typeof state.last.reason === "string" ? state.last.reason : null) === "judgment";
      const questionWorktree = asked && state.unremovedWorktree?.id === (typeof state.last.attemptId === "string" ? state.last.attemptId : state.attemptId);
      if (state.unremovedWorktree && !questionWorktree) await removeWorktreeOf(deps, state, input, state.unremovedWorktree);
      // Whatever the writers left in a folder without git is taken back when no attempt was accepted.
      if (state.last.status !== "accepted") await rollbackLive(deps, state, input);
      // The task is over for these writers (a writer's question keeps its thread: its answer goes on there).
      if (state.last.status !== "accepted" && failureClass(String(state.last.status), typeof state.last.reason === "string" ? state.last.reason : null) !== "judgment") await releaseFailedThreads(deps, state, input);
      // The writer's turns on this task (its first answer and every feedback turn), kept in the stage receipt.
      const turns = state.writerThreadId ? countThreadTurns(db, input.runId, input.taskId, state.writerThreadId) : 0;
      if (turns) state.last = { ...state.last, turns };
      const accepted = state.last.status === "accepted";
      const reason = accepted ? undefined : String(state.last.reason ?? state.last.status ?? "writer_failed");
      // A writer's question would wait unseen: writers are quiet children and do not wake the PM.
      if (!accepted && reason && failureClass(String(state.last.status), reason) === "judgment" && input.pmThreadId) {
        noteToldPmDirectly(db, input.pmThreadId, input.taskId);
        void bestEffort(ctx.log, "writer question notice", sendServiceMessage(bb, { threadId:input.pmThreadId, senderThreadId:state.writerThreadId || undefined,
          text:`Lane Pilot: ${input.taskId} stopped with a question from its writer. Answer it with lane_pilot_answer_writer (taskId, answer) — from the code or docs if they settle it, else ask the owner once; the writer continues in its own thread and no attempt is spent. ${WRITER_QUESTION_WAIT_TEXT} Send the task again only when the contract itself must change; tasks that depend on it wait for that.${state.liveFolder ? " This folder has no git, so the writer's files stay where they are and the folder stays locked: other tasks for it queue until this question is answered (or the task is sent again)." : ""}\n${reason.slice(0, 1200)}` }), undefined);
      }
      // A failed task is told to stability before the receipts close the run: its record reads the run still running
      // (the harness breaker's noteHarnessFailure skips a run that is already blocked). Accepted work emits after the
      // refresh below — the after-acceptance graph starts on the settled run, as before.
      if (!accepted && state.last.status !== "canceled") {
        try {
          await emitAttemptFinished(ctx, { scope:"task", projectId:input.projectId, runId:input.runId, taskId:input.taskId,
            attemptId: state.attemptId, pmThreadId:input.pmThreadId, writerThreadId:state.writerThreadId ?? null, task:input.task, config:state.activeConfig,
            status:String(state.last.status), reason:reason ?? null, result:state.last,
            writerSelection:state.writerSelection ? { providerId:state.writerSelection.providerId, model:state.writerSelection.model } : undefined,
            judged:state.judged && state.judged.status === String(state.last.status) && state.judged.reason === (typeof state.last.reason === "string" ? state.last.reason : null)
              ? { failureClass:state.judged.klass, mast:state.judged.mast ?? null, intervention:state.judged.intervention ?? null, streak:state.judged.streak ?? null } : undefined,
            acceptedAttemptId:null });
        } catch (emitCause) {
          ctx.log(`attempt-finished: emit failed for ${input.taskId}: ${emitCause instanceof Error ? emitCause.message : String(emitCause)}`);
        }
      }
      for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
        const current = listStageReceipts(db, input.runId, input.taskId).find((row) => row.stageId === stageId);
        if (current?.state === "pending") {
          recordStage(db, { runId:input.runId, taskId:input.taskId, stageId, state:"running", input:input.plan });
        }
        const terminal = accepted ? "passed" : state.last.status === "canceled" ? "canceled" : "failed";
        recordStage(db, { runId:input.runId, taskId:input.taskId, stageId, state:terminal,
          input:input.plan, attempt:Math.min(countAttempts(db, input.runId, input.taskId),MAIN_ATTEMPT_LIMIT),
          providerId:stageId==="writer-agent"?state.writerSelection?.providerId:undefined,
          model:stageId==="writer-agent"?state.writerSelection?.model:undefined,threadId:state.writerThreadId,
          result:stageId === "writer-agent" ? {
            ...state.last,
            // #33: the decision this stage made, next to the outcome — failure class, its MAST-14 bucket and the
            // intervention the class's streak got, so receipts read why the retry went this way.
            ...(state.judged ? { decision: { failureClass: state.judged.klass, mast: state.judged.mast ?? null, intervention: state.judged.intervention ?? null, streak: state.judged.streak ?? null } } : {}),
            execution: state.writerSelection ? {
              providerId:state.writerSelection.providerId,
              model:state.writerSelection.model,
              reasoningLevel:state.writerSelection.reasoningLevel ?? null,
              serviceTier:state.writerSelection.serviceTier ?? null,
              selectionSource:state.writerSelection.selectionSource ?? null,
            } : state.last,
          } : accepted ? stageId === "verification"
            ? { produced:state.last.produced, verification:state.last.verification, runV2:state.last.runV2 }
            : state.last : null, reason:accepted ? undefined : reason });
      }
      refreshRun(input.runId);
      if (accepted) {
        try {
          await emitAttemptFinished(ctx, { scope:"task", projectId:input.projectId, runId:input.runId, taskId:input.taskId,
            attemptId: state.attemptId, pmThreadId:input.pmThreadId, writerThreadId:state.writerThreadId ?? null, task:input.task, config:state.activeConfig,
            status:"accepted", reason:null, result:state.last,
            writerSelection:state.writerSelection ? { providerId:state.writerSelection.providerId, model:state.writerSelection.model } : undefined,
            acceptedAttemptId: state.acceptedAttemptId });
        } catch (emitCause) {
          ctx.log(`attempt-finished: emit failed for ${input.taskId}: ${emitCause instanceof Error ? emitCause.message : String(emitCause)}`);
        }
      }
      };
