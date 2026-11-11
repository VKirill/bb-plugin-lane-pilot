import { appetiteStop, breakerKey, runningWriterBudgetStop, tokenUsageFromEvent } from "@lane-pilot/resilience";
import type { ServerCore } from "../../contracts/server";
import type { FinishInput, Services } from "./finish-types";
import type { AttemptFinished } from "./attempt-finished";
import { countAttempts, getAttempt, getReasoningTrace, getTaskPlan, getRunSettingsScopes, loadProjectSettings, transitionAttempt } from "../../storage";
import { closeWriterStages } from "../../runs/server";
import { THREAD_WATCH_EVENT_TYPES, listThreadEventsRaw, sleepUntilThreadSignal, startLimitWaiting, threadFailure, threadWatchMark, waitThreadIdle } from "@lane-pilot/thread-observe";
import { setAsideOnStartFailure } from "../../platform/server";
import { bestEffort, pollPause, stringAt } from "@lane-pilot/kit";
import { clearFollowUpCancelled, followUpCancelled, loadFollowUp } from "./sticky";
import { loadWriterNudge } from "./writer-silence";
import { THREAD_NOT_STARTED_REASON, WRITER_SILENT_REASON } from "../../contracts/failure-class";

const FOLLOW_UP_DELETED = "the owner deleted the queued instruction for this writer";

/** How long an idle writer whose background command still runs is waited for before its work is validated as it stands. */
const BACKGROUND_TAIL_WAIT_MS = 5 * 60_000;

export interface WatchWriterDeps {
  ctx: ServerCore;
  services: Services;
  input: FinishInput;
  facts: Pick<AttemptFinished, "writerStopped">;
  providerFailed: (reason: string) => Record<string, unknown> | null;
  holdProviderLimit: (until?: number) => void;
}

/** The writer's run watch: the follow-up wait, the budget stop and the poll loop until the thread is idle or failed. Returns the finish result, or null when the writer ended normally. */
export async function watchWriterRun(deps: WatchWriterDeps): Promise<Record<string, unknown> | null> {
  const { ctx, services, input, facts, providerFailed, holdProviderLimit } = deps;
  const { bb, db, getThreadBounded } = ctx;
      const budget = services.runBudgetFor(input.runId, loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId)));
      // The task's own appetite (contract `appetite`) is watched next to the run's budget: this writer's tokens and the time since the
      // wait began (a reload starts the clock again: the appetite is then counted generously, never twice).
      const appetite = input.task.appetite;
      const attemptStartedAt = Date.now();
      let writerTokens: number | null = null;
      const watchBudget = budget.snapshot().limits.maxWallMs !== undefined || budget.snapshot().limits.maxTokens !== undefined || appetite?.minutes !== undefined;
      const noteWriterTokens = async () => {
        if (budget.snapshot().limits.maxTokens === undefined) return;
        try {
          const usageListed = await bb.sdk.threads.events.list({ threadId:input.writerThreadId, types:["thread/tokenUsage/updated"], order:"desc", limit:"50" });
          const usage = Array.isArray(usageListed) ? tokenUsageFromEvent(usageListed[0]) : null;
          if (usage) { writerTokens = usage.totalTokens; budget.noteTokens(usage.threadId, usage.totalTokens); }
        } catch (cause) { ctx.log(`writer ${input.taskId}: usage events unreadable: ${cause instanceof Error ? cause.message : String(cause)}`); }
      };
      // Stage budget question: at four fifths of the task's appetite minutes the PM is asked once whether to extend them (lane_pilot_update_task)
      // or let the writer stop. The appetite's tokens are a forecast only (packages/resilience/src/appetite.ts): no question, no stop.
      let budgetAsked = false;
      const askBudgetOnce = () => {
        if (budgetAsked || !appetite?.minutes || !input.pmThreadId) return;
        const timeUsed = (Date.now() - attemptStartedAt) / (appetite.minutes * 60_000);
        if (timeUsed < 0.8) return;
        budgetAsked = true;
        void bestEffort(ctx.log, "writer budget note", Promise.resolve().then(() => bb.sdk.threads.send({ threadId:input.pmThreadId!, mode:"queue-if-active", input:[{ type:"text", mentions:[], text:`[Lane Pilot] Task ${input.taskId} has spent ${Math.round(timeUsed * 100)}% of its appetite (${Math.round((Date.now() - attemptStartedAt) / 60_000)}/${appetite.minutes} min). Its writer stops at the appetite: raise it with lane_pilot_update_task now if the work is worth more, or let it stop.` }] } as never)), undefined);
      };
      const overBudget = () => { askBudgetOnce(); return runningWriterBudgetStop(budget.check()) ?? appetiteStop(appetite, { tokens:writerTokens, elapsedMs:Date.now() - attemptStartedAt }); };
      const stopRunningWriter = async (reason:string) => {
        const current = await bestEffort(ctx.log, "writer thread status", getThreadBounded(input.writerThreadId), null);
        const status = stringAt(current, "status");
        if (["active", "starting"].includes(status ?? "")) await bestEffort(ctx.log, "writer thread stop", bb.sdk.threads.stop({ threadId:input.writerThreadId }), undefined);
        transitionAttempt(db, input.attemptId, "blocked", { reason });
        closeWriterStages(db, {
          runId:input.runId, taskId:input.taskId, plan:getTaskPlan(db, input.taskId) ?? "",
          terminal:"failed", attempt:countAttempts(db, input.runId, input.taskId), reason, threadId:input.writerThreadId,
        });
        facts.writerStopped = true;
        return { status:"blocked", reason, attemptId:input.attemptId, writerThreadId:input.writerThreadId };
      };
      // A continued thread is idle from its previous task until the new turn starts: wait for the turn sent after `since`.
      clearFollowUpCancelled(bb, input.attemptId);
      const followUpSince = await loadFollowUp(bb.storage.kv, input.attemptId);
      if (followUpSince !== null) {
        try {
          const deleted = () => followUpCancelled(bb, input.attemptId) ? FOLLOW_UP_DELETED : null;
          if (!watchBudget) {
            await waitThreadIdle(bb, input.writerThreadId, "writer_follow_up", undefined, followUpSince, deleted);
          } else {
            let waiting = true;
            const idle = waitThreadIdle(bb, input.writerThreadId, "writer_follow_up", undefined, followUpSince, deleted)
              .finally(() => { waiting = false; });
            // A budget stop returns before this wait ends; its later rejection (thread_interrupted) must not go unhandled, which kills the BB server.
            void bestEffort(ctx.log, "writer idle wait", idle, undefined);
            while (waiting) {
              await noteWriterTokens();
              const budgetStop = overBudget();
              if (budgetStop) return await stopRunningWriter(budgetStop);
              await Promise.race([idle, new Promise((wake) => setTimeout(wake, 2_000))]);
            }
            await idle;
          }
        } catch (cause) {
          if (ctx.state.disposed) throw new Error("Lane Pilot was reloaded while the writer ran");
          const reason = cause instanceof Error ? cause.message : String(cause);
          // The owner deleted the queued instruction: it never reaches the writer, so the task is blocked, not retried.
          if (reason.endsWith(FOLLOW_UP_DELETED)) return await stopRunningWriter(`follow_up_deleted: ${FOLLOW_UP_DELETED}`);
          return providerFailed(reason);
        }
      }
      // A writer runs as long as it works, unless the run's wall or token budget is gone; BB's events say when it has failed.
      let completedThread: unknown;
      let tailSince = 0;
      /** How many background commands of the writer's session still run; threads.get has no such count, the environment's thread list does. */
      const backgroundTail = async (envId: string | null | undefined): Promise<number> => {
        const listed = envId ? await (bb.sdk.threads.list({ environmentId:envId, includeHidden:true } as never) as Promise<unknown>).catch(() => null) : null;
        const row = Array.isArray(listed) ? (listed as Array<{ id:string; activity?:{ activeBackgroundCommandCount?:number } }>).find((item) => item.id === input.writerThreadId) : undefined;
        return row?.activity?.activeBackgroundCommandCount ?? 0;
      };
      for (;;) {
        if (ctx.state.disposed) throw new Error("Lane Pilot was reloaded while the writer ran");
        const pollStarted = Date.now();
        const mark = threadWatchMark(bb);
        const currentThread = await getThreadBounded(input.writerThreadId);
        const currentStatus = stringAt(currentThread, "status");
        // The silence sweep nudged this writer twice and it stayed silent: the attempt ends and the task moves on.
        const nudge = await loadWriterNudge(bb.storage.kv, input.attemptId);
        if (nudge?.ended) {
          // The silence sweep found a provider limit in the log (writer-silence.ts): that reason, else the silent one.
          // The turn ceiling (writer.max_turns) ends the attempt as a budget stop, like the task's appetite minutes: the thread is
          // stopped, the worktree stays, the task is blocked and no retry is spent. It says nothing about the provider: no breaker, no hold.
          if (nudge.turnCeiling && nudge.reason) return await stopRunningWriter(nudge.reason);
          const reason = nudge.reason ?? `${WRITER_SILENT_REASON}: no activity after ${nudge.count} nudges`;
          if (nudge.reason) holdProviderLimit(nudge.until);
          const ended = providerFailed(reason);
          if (["active", "starting"].includes(currentStatus ?? "")) await bestEffort(ctx.log, "writer thread stop", bb.sdk.threads.stop({ threadId:input.writerThreadId }), undefined);
          return ended;
        }
        const listed = currentStatus === "idle" ? null : await listThreadEventsRaw(bb, { threadId:input.writerThreadId, types:THREAD_WATCH_EVENT_TYPES, order:"desc", limit:"50" });
        const eventFailure = listed?.ok ? threadFailure(listed.events) : null;
        // The core could not start the session («Command thread.start failed»): the task never ran. The pair is set aside for an hour and the
        // attempt ends as an unavailable provider — free, and the chain's next writer takes it at once (feed-gen 2026-11-10: four dead
        // Antigravity starts read «writer thread status error», spent the task's two attempts and parked it).
        const notStarted = eventFailure && /thread\.start failed/i.test(eventFailure) ? eventFailure : null;
        if (notStarted) {
          const trace = getReasoningTrace(db, input.attemptId);
          if (trace) setAsideOnStartFailure(bb, `writer for ${input.taskId}`, trace.providerId, trace.model, notStarted);
          holdProviderLimit();
        }
        const rawFailure = notStarted ? `${THREAD_NOT_STARTED_REASON}: ${notStarted}`
          : currentStatus === "error" ? `writer thread status error${eventFailure ? `: ${eventFailure}` : ""}` : eventFailure;
        // A turn held in the concurrency-limit queue is waiting its turn: the provider's start limit is not a failure then.
        const failure = await startLimitWaiting(bb, input.writerThreadId, rawFailure) ? null : rawFailure;
        if (failure) {
          const ended = providerFailed(failure);
          if (["active", "starting"].includes(currentStatus ?? "")) await bestEffort(ctx.log, "writer thread stop", bb.sdk.threads.stop({ threadId:input.writerThreadId }), undefined);
          return ended;
        }
        if (currentStatus === "idle") {
          // An idle thread whose background command still runs is not finished (SMA ag_infra): BB wakes the writer when the
          // command ends, so validating now would judge half the work. Wait for it, at most BACKGROUND_TAIL_WAIT_MS — a
          // command that never ends (a dev server left up) must not hold the attempt.
          const tail = await backgroundTail(stringAt(currentThread, "environmentId"));
          if (tail > 0 && Date.now() - (tailSince ||= Date.now()) < BACKGROUND_TAIL_WAIT_MS) {
            await new Promise((resolve) => setTimeout(resolve, pollPause(5_000)));
            continue;
          }
          if (tail > 0) ctx.log(`writer ${input.taskId}: ${tail} background command(s) still running ${Math.round(BACKGROUND_TAIL_WAIT_MS / 60_000)} min after the turn ended; validating what is on disk`);
          completedThread = currentThread;
          break;
        }
        tailSince = 0;
        if (watchBudget) {
          await noteWriterTokens();
          const budgetStop = overBudget();
          if (budgetStop) return await stopRunningWriter(budgetStop);
        }
        // A run with a wall or token budget is read every 2 s, because the budget is checked here. Otherwise BB's events
        // (idle, failed, archived) wake the loop, and a read every 20 s covers a lost event.
        const pause = Math.max(0, 2_000 - (Date.now() - pollStarted));
        if (watchBudget) await new Promise((resolve) => setTimeout(resolve, pollPause(pause)));
        else await sleepUntilThreadSignal(bb, input.writerThreadId, mark, pause);
      }
  return null;
}
