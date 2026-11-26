import { WRITER_FALLBACK_ON_PROVIDER_FAILURE_KEY, WRITER_RETRY_ESCALATE_KEY, WRITER_RETRY_SAFETY_KEY, FAILURE_INTERVENTIONS_KEY } from "../../settings";
import { retrySafetyStop } from "./retry-safety";
import { countChargedAttempts, failureFieldsOf, getAttempt, attemptReasonsForTask, priorAttemptStates, transitionAttempt } from "../../../storage";
import { postOwnerItem } from "../../../owner-waiting";
import { bestEffort } from "@lane-pilot/kit";
import { reconcile } from "../../../stability";
import { reconcileCursor } from "../../../stability/server";
import { RETRY_ELIGIBLE, WRITER_RETRY_LIMIT } from "../../../contracts";
import { PARKED_CLASSES, VERIFICATION_TIMEOUT_RETRIES, failureFingerprint, isWaitingSecret, isWriterSilent, verificationTimeoutOverBudget } from "../../../contracts";
import { failureClass, failureIntervention, MAST_OF_FAILURE } from "../../../contracts";


import { copyRefusedKeyPrefix } from "../../models/copy-refused-key";
import { verificationFailure } from "../repositories/start-failure-records";
import { type WriterTaskState } from "./start-task-state";
import { rollbackLive } from "./start-live-folder";
import { otherWriters } from "./start-other-writers";

import type { AttemptState } from "../../../contracts";
import { configuredSetting } from "../../../contracts/server";
import { findThreadsByMetadata } from "../../../platform/server";


import type { StartWriterTaskDeps } from "./start-writer-task";
import type { WriterTaskInput } from "./start-task-state";

/** After a failed attempt: classify, and route — block and leave the loop, or fall through to the respawn. */
export const routeAttemptFailure = async (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput, route: {
  failedBinding: ReturnType<typeof getAttempt>;
  redo: Awaited<ReturnType<StartWriterTaskDeps["sticky"]["retryWriter"]>>;
  sessionEnd: string | null;
  streamHandOff: boolean;
  turn: { failure: unknown; diff: string | null; streamError: boolean };
}):Promise<"break"|"next"> => {
        const { ctx, services } = deps;
        const { bb, db, host } = ctx;
        const { failedBinding, redo, sessionEnd, streamHandOff, turn } = route;
        // The worktree waits: the next attempt removes it when it starts, and a fallback writer may continue in it (below).
        if (!redo) { state.unremovedWorktree = failedBinding; await rollbackLive(deps, state, input); }
        if (state.last.status === "spawn_rejected" && typeof state.last.reason === "string"
          && (state.last.reason.startsWith("execution_packet_failed:") || state.last.reason.startsWith("attempt_worktree_")
            || state.last.reason.startsWith("attempt_workspace_"))) {
          const rejected = getAttempt(db, state.attemptId);
          if (rejected?.state === "spawn_rejected") transitionAttempt(db, state.attemptId, "blocked", { reason:state.last.reason });
          // The working copy could not be made for a cause only a person clears (a stale path, a permission,
          // a full disk): parked as now, and the reason is put before the owner once per refusal fingerprint
          // — a machine wait never reaches a human otherwise (sma ap_copy_refusal).
          if (state.last.reason.startsWith("attempt_worktree_")) {
            const detail = state.last.reason.replace(/^attempt_worktree_(failed|baseline_failed|not_clean|provision_[a-z_]+):?/, "") || state.last.reason;
            postOwnerItem(db, { key:`${copyRefusedKeyPrefix(input.runId, input.taskId)}${failureFingerprint(state.last.reason)}`, source:"writer", kind:"copy_refused", reason:"blocked", projectId:input.projectId, wake:false,
              what:"Рабочая копия для задачи не создалась",
              why:`Причина: ${detail}. Задача припаркована: сама она не запустится, её нужно отправить снова после устранения причины.`,
              evidence:[{ kind:"run", ref:input.runId }, { kind:"task", ref:input.taskId }, { kind:"attempt", ref:state.attemptId }] });
          }
          state.last = { ...state.last, status:"blocked" };
          return "break";
        }
        if (state.last.status !== "accepted" && state.last.status !== "blocked") state.primaryFailure={...state.last};
        const failed = String(state.last.status) as AttemptState;
        if (!RETRY_ELIGIBLE.includes(failed)) return "break";
        const attempt = getAttempt(db, state.attemptId);
        if (attempt?.state === "spawn_unknown" || attempt?.state === "spawn_requested") {
          state.writerThreadId = await bestEffort(ctx.log, "writer reconcile attempt thread", services.reconcileAttemptThread(input.projectId, attempt), "");
        } else if (attempt && !attempt.thread_id && attempt.state !== "spawn_rejected") {
          // An attempt whose writer thread is stored needs no scan; scanning every thread of the project here blocked
          // retries with reconcile_page_cap once SelfyStudio passed 1000 threads (live 2026-10-04).
          const cursor = reconcileCursor(db, attempt.id, "writer");
          const scanned = await reconcile({
            list: async ({ limit, offset }) => (await bb.sdk.threads.list({
              projectId:input.projectId, originPluginId:"lane-pilot", includeHidden:true, archived:false, limit, offset,
            })).map((thread) => ({ id:thread.id })),
            metadata: async (threadId) => bb.sdk.threads.getPluginMetadata({ threadId }),
            find: (match) => findThreadsByMetadata(bb, match, input.projectId),
          }, { lanePilotRunId:attempt.run_id, lanePilotTaskId:attempt.task_id, attemptId:attempt.id }, { cursor });
          // page_cap and a death mid-page leave the cursor. The attempt stays, and the next process reads the same page.
          if ((scanned.kind === "blocked" && scanned.reason === "page_cap") || (scanned.kind === "error" && cursor.read() !== null)) return "break";
          if (scanned.kind === "blocked" || scanned.kind === "error") {
            // Both end the attempt: an error left it «spawn_rejected» with its stages closed, and nothing retried it (found by the
            // fault-injection simulation, tests/simulation). A reconcile_ reason is Lane Pilot's fault: the task is parked.
            transitionAttempt(db, attempt.id, "blocked", { reason:scanned.kind === "blocked" ? `reconcile_${scanned.reason}` : `reconcile_error: ${scanned.message}` });
            state.last = { ...state.last, status:"blocked", reason:scanned.kind === "blocked" ? scanned.reason : scanned.message };
            return "break";
          }
        }
        // A fault of Lane Pilot or the machine is not redone here: another writer meets the same fault. The task is
        // parked and restarts once a fix ships or the machine recovers.
        // The class is the dictionary's (classifyFailure, from the attempt's own facts: its state and reason), as SMA's ag_classify does.
        const failedClass = failureClass(String(state.last.status), typeof state.last.reason === "string" ? state.last.reason : null);
        // C6: a class's own intervention instead of the same retry — the streak of consecutive same-class failures of
        // this task decides. `failure.interventions=off` keeps the old uniform retry (live setting).
        const priorRows = priorAttemptStates(db, input.runId, input.taskId, state.attemptId);
        let sameClassStreak = 1;
        for (const row of priorRows) { if (failureClass(row.state, row.reason) === failedClass) sameClassStreak++; else break; }
        const intervention = configuredSetting(state.runSettings, FAILURE_INTERVENTIONS_KEY) === "off" ? "same_retry_remark" : failureIntervention(failedClass, sameClassStreak);
        state.judged = { status: String(state.last.status), reason: typeof state.last.reason === "string" ? state.last.reason : null, klass: failedClass, mast: MAST_OF_FAILURE[failedClass] ?? "external:unknown", intervention, streak: sameClassStreak };
        // A check the host killed for time is not the task's red code: one retry, then it stops on its own budget.
        if (failedClass === "verification_timeout") {
          const reasons = attemptReasonsForTask(db, input.runId, input.taskId);
          if (verificationTimeoutOverBudget(reasons)) {
            const reason = `verification_timeout_budget: the check timed out again after its ${VERIFICATION_TIMEOUT_RETRIES} retry; this budget is separate from the task's attempts. Raise timeout_sec or narrow the command, then dispatch again`;
            const latest = getAttempt(db, state.attemptId);
            if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason, ...failureFieldsOf(state.last) });
            state.last = { ...state.last, status:"blocked", reason };
            return "break";
          }
        }
        // A provider that takes no work fails every retry the same way: the writer chain below takes the task now.
        // The attempt ends blocked with its limit reason (uncharged); primaryFailure keeps the state the chain reads.
        // A writer that stayed silent through its nudges is handed on the same way: its session hung, not the task.
        // A provider refusal (a limit, an unavailable provider, a 5xx) hands over at once by default — one more attempt
        // of the same model only repeats the refusal (owner_present held writers 20 h, graphs-optimisation G10); the
        // `writer.fallback_on_provider_failure=after_retry` keeps the classic retry order (one more attempt of the same model first).
        // A stream cut is not a refusal: the provider cut a turn mid-work, its edits are in the worktree, and the same
        // thread continues them once as before — only a second cut in a row is the provider's (streamHandOff above).
        const providerHandsOff = failedClass === "provider" && !turn.streamError
          && state.runSettings[WRITER_FALLBACK_ON_PROVIDER_FAILURE_KEY] !== "after_retry"
          // No other writer to hand over to: the same model is tried again (free), instead of a block nobody else could lift.
          && otherWriters(deps, state, input).fallbackList.length > 0;
        if (failedClass === "limit" || providerHandsOff || isWriterSilent(typeof state.last.reason === "string" ? state.last.reason : null) || streamHandOff) {
          const latest = getAttempt(db, state.attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason:String(state.last.reason ?? state.last.status), ...failureFieldsOf(state.last) });
          state.last = { ...state.last, status:"blocked" };
          return "break";
        }
        // A secret the checks need went away mid-task: the attempt is not charged and the task is parked until it is back.
        if (PARKED_CLASSES.has(failedClass) || isWaitingSecret(typeof state.last.reason === "string" ? state.last.reason : null)) {
          const latest = getAttempt(db, state.attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason:String(state.last.reason ?? state.last.status), ...failureFieldsOf(state.last) });
          state.last = { ...state.last, status:"blocked" };
          return "break";
        }
        // The retry-safety gate (writer.retry_safety): an automatic retry stops when the failed attempt's work area was
        // touched after it ended (owner edits, rewritten check evidence, a catalog secret in the diff).
        if (configuredSetting(state.runSettings, WRITER_RETRY_SAFETY_KEY) !== "off") {
          const safety = await retrySafetyStop({ db, host, hostId:input.config.hostId, task:state.freshTask, attemptId: state.attemptId, liveFolder: state.liveFolder, log:ctx.log });
          if (safety) {
            const latest = getAttempt(db, state.attemptId);
            if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason:safety });
            state.last = { ...state.last, status:"blocked", reason:safety };
            return "break";
          }
        }
        // The session ended: the turn cap or the wall cap blocks the task. A repeated red check (the same failure and
        // the same diff twice) does not: the next attempt goes to the next writer in the chain, not this one again.
        if (sessionEnd) {
          const ended = `${sessionEnd}: ${String(state.last.reason ?? state.last.status)}`;
          if (sessionEnd.startsWith("no progress:") && failedClass !== "verification_timeout" && verificationFailure(state.last)) {
            state.checkEscalation = ended;
            return "break";
          }
          const latest = getAttempt(db, state.attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason:ended, ...failureFieldsOf(state.last) });
          state.last = { ...state.last, status:"blocked", reason:ended };
          return "break";
        }
        if (countChargedAttempts(db, input.runId, input.taskId) >= WRITER_RETRY_LIMIT
          || state.attemptsHere >= WRITER_RETRY_LIMIT) {
          const latest = getAttempt(db, state.attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) {
            const exhausted = `retry limit ${WRITER_RETRY_LIMIT} exhausted${typeof state.last.reason === "string" && state.last.reason ? `: ${state.last.reason}` : ""}`;
            transitionAttempt(db, latest.id, "blocked", { reason:exhausted, ...failureFieldsOf(state.last) });
            state.last = { ...state.last, status:"blocked", reason:exhausted };
          }
          return "break";
        }
        // Cascade retry (arXiv #25/26, writer.retry_escalate): with the setting on, the first red check already goes to
        // the next writer in the fallback chain — a cheaper writer failing the task's check is reason enough to try
        // the next one, inside the same attempt budget. Off by default: a single failure retries the same writer.
        if (failedClass === "task" && verificationFailure(state.last) && state.runSettings[WRITER_RETRY_ESCALATE_KEY] === true) {
          state.checkEscalation = `retry_escalate: ${String(state.last.reason ?? "")}`;
          state.primaryFailure = { ...state.last };
          return "break";
        }
        // The session goes on, and how it goes on is already decided: an in-thread continue (redo) is itself the
        // intervention for a fixable failure, and the classic handoffs above already took the failures they own.
        // What is left here is only a same-model respawn — the move C6 replaces by class: a task that keeps failing
        // the same way stops with narrow_brief, and a provider's second refusal in a row (or its first, with
        // writer.fallback_on_provider_failure=immediate, decided above) moves the task to the next writer now.
        if (!redo && intervention === "narrow_brief" && !state.liveFolder) {
          // The original reason stays in the blocked reason: the class and the advice are a prefix, not a replacement —
          // a receipt reader (and the live-folder rollback test) still sees what actually failed.
          const reason = `narrow_brief: ${String(state.last.reason ?? state.last.status)} — ${failedClass} failed ${sameClassStreak} attempts in a row; narrow the brief or change the approach, then dispatch again`;
          const latest = getAttempt(db, state.attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason, ...failureFieldsOf(state.last) });
          state.last = { ...state.last, status:"blocked", reason };
          return "break";
        }
        if (!redo && intervention === "next_writer" && failedClass === "provider" && sameClassStreak >= 2) {
          const latest = getAttempt(db, state.attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason:String(state.last.reason ?? state.last.status), ...failureFieldsOf(state.last) });
          state.last = { ...state.last, status:"blocked" };
          return "break";
        }
        // On pipeline-driven attempts, yield back to the workflow graph once in-session redos and effort escalation cannot proceed.
        if (input.singleAttempt && !redo && !(failedClass === "provider" && state.runSettings[WRITER_FALLBACK_ON_PROVIDER_FAILURE_KEY] === "after_retry" && state.attemptsHere === 1)) {
          return "break";
        }
        return "next";
}

export { lastOwnFailure } from "../repositories/start-failure-records";
