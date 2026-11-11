import { configuredSetting } from "../../contracts/server";
import { providerPoolCap } from "@lane-pilot/settings-catalog";
import { runningWriterBudgetStop } from "@lane-pilot/resilience";
import { countAttempts, getAttempt, getTask, getTaskPlan, taskBasePath, taskHeldUntil, taskTimelineRow } from "../../storage";
import { recoveryState } from "../../rollback";
import { getRunSettingsScopes, listOpenAttempts, listTaskLatestAttemptStates, loadProjectSettings } from "../../storage";
import { taskV2Schema } from "../../contracts";
import { pollPause } from "@lane-pilot/kit";
import { isHeld, waitWhileRunPaused } from "../../runs/server";
import { recordStage } from "../../runs/server";
import { HOLD_FOREVER, laneCap, laneQueueOf, priorityRank, spendReserve } from "../../tasks";
import { freshAttemptStart } from "./fresh-attempt-start";
import { resolve } from "node:path";
import { waitForDependencies } from "./start-wait-dependencies";
import { waitForOverlappingTasks } from "./start-wait-overlap";
import { waitForRegressionQuarantine } from "./start-wait-quarantine";
import { waitForSecrets } from "./start-wait-secrets";
import { blockBeforeWriter, parkForStoreRead } from "./start-prepare-run";
import type { StartWriterTaskDeps } from "./start-writer-task";
import type { WriterTaskInput, WriterTaskState } from "./start-task-state";

const wallOrTokenStop = (state: WriterTaskState) => runningWriterBudgetStop(state.budget.check());
/**
 * The permit's money half (SMA ac_permit): with run.max_tokens the task must carry its price (dispatch lints
 * price_unknown; this start is the same refusal for a retry that never saw the lint) and the run's budget must
 * still hold its appetite after the run's other open tasks'.
 */
export const writerPermit = (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput): string | null => {
  const { ctx } = deps;
  const { db } = ctx;
  const snap = state.budget.snapshot();
  if (!snap.limits.maxTokens) return null;
  const appetite = input.task.appetite?.tokens;
  if (!appetite) return `permit_refused:price_unknown: the run has run.max_tokens but task ${input.taskId} names no appetite.tokens`;
  const openAppetites = listOpenAttempts(db).filter((row) => row.run_id === input.runId && row.task_id !== input.taskId)
    .map((row) => Number((getTask(db, row.task_id)?.contract as { appetite?: { tokens?: number } } | undefined)?.appetite?.tokens ?? 0));
  const reserve = spendReserve({ budgetTokens:snap.limits.maxTokens, spentTokens:snap.tokens, openAppetites, appetite });
  return reserve.ok ? null : `permit_refused:reserve: ${reserve.why}`;
};
  /** The waits a task passes before its writer gets a turn: depends_on, overlapping tasks, secrets, the breaker and the pools. */
  export const waitForAdmission = async (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput): Promise<boolean> => {
  const { ctx, services } = deps;
  const { bb, db, markCanceledWriterStages, refreshRun } = ctx;
    // A paused run lets nothing new start (bb lane-pilot pause): the task waits here, before it takes any slot, and goes on by itself on resume.
    if (!await waitWhileRunPaused(bb.storage.kv as never, input.runId, { isDisposed: ctx.isDisposed, onError: (message) => bb.log.warn(message), onFirstWait: () => {
      ctx.log(`writer ${input.taskId} waits: run ${input.runId} is paused`);
      recordStage(db, { runId:input.runId, taskId:input.taskId, stageId:"writer-agent", state:"pending", input:input.plan,
        reason:"waiting: the run is paused; starts by itself once it is resumed" });
    }, onReadBound: (cause) => { parkForStoreRead(deps, state, input, cause); return false; } })) return false;
    // Held until a date (2999 = until released): the task stays queued and takes no slot (lane_pilot_queue {action:"hold"}).
    for (let noted = false; !ctx.isDisposed();) {
      const held = taskHeldUntil(db, input.taskId);
      if (!held || held <= Date.now()) break;
      if (!noted) {
        noted = true;
        recordStage(db, { runId:input.runId, taskId:input.taskId, stageId:"writer-agent", state:"pending", input:input.plan,
          reason:`waiting: held until ${held >= HOLD_FOREVER ? "released" : new Date(held).toISOString()}` });
      }
      await new Promise((wake) => setTimeout(wake, pollPause(10_000)));
    }
    const dependency = await waitForDependencies(deps, state, input, () => wallOrTokenStop(state));
    if (dependency) {
      blockBeforeWriter(deps, state, input, dependency);
      return false;
    }
    const overlapStop = await waitForOverlappingTasks(deps, state, input, () => wallOrTokenStop(state));
    if (overlapStop) {
      blockBeforeWriter(deps, state, input, overlapStop);
      return false;
    }
    const quarantineStop = await waitForRegressionQuarantine(deps, state, input, () => wallOrTokenStop(state));
    if (quarantineStop) {
      blockBeforeWriter(deps, state, input, quarantineStop);
      return false;
    }
    const secretStop = await waitForSecrets(deps, state, input, () => wallOrTokenStop(state));
    if (secretStop) {
      blockBeforeWriter(deps, state, input, secretStop);
      return false;
    }
    // Several tasks failed on the same Lane Pilot fault just now, or the disk is nearly full: starting more only burns them too.
    for (let noted = ""; ;) {
      if (ctx.isDisposed()) return false;
      const budgetStop = wallOrTokenStop(state);
      if (budgetStop) { blockBeforeWriter(deps, state, input, budgetStop); return false; }
      // An attempt canceled while it waits stops waiting: the drill's canceled writers kept polling the full Mac mini disk and
      // logging for half an hour after their cancel (2026-10-27, drill-20261027-023238-memory, drill-pm-20261027-note).
      const waiting = getAttempt(db, state.attemptId);
      if (!waiting || ["canceled", "blocked", "accepted"].includes(waiting.state)) {
        if (waiting?.state === "canceled") {
          markCanceledWriterStages(waiting, "writer attempt canceled while it waited for room");
          refreshRun(input.runId);
        }
        return false;
      }
      const base = taskBasePath(db, input.runId, input.taskId);
      // Money and the subscription window: a paid lane over the month's cap, or a Claude window at 98%, waits (src/rooms/money).
      const moneyProvider = typeof state.runSettings["writer.provider"] === "string" && state.runSettings["writer.provider"] ? state.runSettings["writer.provider"] as string : input.config.writerProviderId;
      const moneyModel = typeof state.runSettings["writer.model"] === "string" ? state.runSettings["writer.model"] as string : "";
      const held = services.stability.breakerHolds(input.projectId)
        ?? (base ? await services.stability.diskHolds(input.config.hostId, base) : null)
        ?? (services.money ? await services.money.holds(moneyProvider, moneyModel, input.config.hostId) : null);
      if (!held) break;
      // One wait is one log line: a busy disk's free space moves by a GB every few polls, and «only 9 GB free» → «8» → «7» → «9»
      // logged 61 warnings for one drill writer (Mac mini, 2026-10-27). A new number only refreshes the stage reason.
      if (noted !== held) {
        if (noted.replace(/\d+/g, "<n>") !== held.replace(/\d+/g, "<n>")) ctx.log(`writer ${input.taskId} waits: ${held}`);
        noted = held;
        recordStage(db, { runId:input.runId, taskId:input.taskId, stageId:"writer-agent", state:"pending", input:input.plan,
          reason:`waiting: ${held}; starts by itself once it clears` });
      }
      await new Promise((wake) => setTimeout(wake, pollPause(30_000)));
    }
    // Idle pass (SMA dt_idle): a wait on a full pool is named — which pool, and that it frees by itself.
    // Stage above ordinary work: a phase-born task without a priority of its own ranks one band above urgent.
    const rank = priorityRank(input.task.priority, taskTimelineRow(db, input.taskId, input.runId)?.birth);
    const noteBusy = (key:string, limit:number, seats:string) => {
      if (services.runWriterPool.busy?.(key, limit)) recordStage(db, { runId:input.runId, taskId:input.taskId, stageId:"writer-agent", state:"pending", input:input.plan,
        reason:`waiting: all ${limit} writer seats of the ${seats} are busy; starts by itself when one frees` });
    };
    state.releaseWriterSlot=state.liveFolder
      ? (noteBusy(`live-folder:${input.config.hostId}:${resolve(state.runFolder)}`, 1, "host"), await services.runWriterPool.acquire(`live-folder:${input.config.hostId}:${resolve(state.runFolder)}`,1))
      : (noteBusy(input.runId, state.policy.pools.provider, "run"), await services.runWriterPool.acquire(input.runId,state.policy.pools.provider,rank));
    // BB's concurrency-limit plugin caps the threads a host runs at once: writers beyond it would only wait in BB's queue,
    // so they wait here, before their attempt starts (no pool slot is held by a writer that cannot run). No plugin, no cap.
    const hostCap = await services.concurrencyLimit.hostCap(input.config.hostId);
    if (hostCap !== null && !state.liveFolder) {
      const releaseRunSlot = state.releaseWriterSlot;
      const hostLimit = Math.min(hostCap, 15);
      noteBusy(`concurrency-limit:${input.config.hostId}`, hostLimit, "host");
      const releaseHostSlot = await services.runWriterPool.acquire(`concurrency-limit:${input.config.hostId}`, hostLimit);
      state.releaseWriterSlot = () => { releaseHostSlot(); releaseRunSlot?.(); };
    }
    // G9: a cap on simultaneous writers of one provider (ops.provider_pool); a task over it waits here, queued, not failed.
    // It counts the task's writer provider; a fallback of the chain is not counted. No entry, no cap.
    const poolProvider = typeof state.runSettings["writer.provider"] === "string" && state.runSettings["writer.provider"] ? state.runSettings["writer.provider"] as string : input.config.writerProviderId;
    const providerCap = providerPoolCap(state.runSettings, poolProvider);
    if (providerCap !== null && !state.liveFolder) {
      const releaseHeld = state.releaseWriterSlot;
      noteBusy(`provider-pool:${poolProvider}`, providerCap, "provider");
      const releaseProviderSlot = await services.runWriterPool.acquire(`provider-pool:${poolProvider}`, providerCap);
      state.releaseWriterSlot = () => { releaseProviderSlot(); releaseHeld?.(); };
    }
    // Four lane queues: writing, checks, docs and research each wait in their own queue when the project caps it (queue.lane_caps).
    const lane = laneQueueOf(input.task.kind);
    const capOfLane = laneCap(state.runSettings["queue.lane_caps"], lane);
    if (capOfLane !== null && !state.liveFolder) {
      const releaseHeld = state.releaseWriterSlot;
      noteBusy(`lane-queue:${input.projectId}:${lane}`, capOfLane, "lane");
      const releaseLaneSlot = await services.runWriterPool.acquire(`lane-queue:${input.projectId}:${lane}`, capOfLane, rank);
      state.releaseWriterSlot = () => { releaseLaneSlot(); releaseHeld?.(); };
    }
    // The claim is fetch-plus-holds in one step: a hold that arrived while the task waited for a seat (a task hold,
    // a pause, the conveyor, a breaker) is re-checked now, not only before the pool wait — the slots go back and
    // the task waits again, queued, instead of starting held work (sma dt_claim).
    const lateHold = taskHeldUntil(db, input.taskId);
    const lateBreaker = services.stability.breakerHolds(input.projectId);
    // An unreadable pause/conveyor flag is not decided here: the stage-boundary wait below holds on it and tells
    // the owner (pause-read item). Swallowing it here would queue the task again and again with nobody told.
    const latePaused = await isHeld(bb.storage.kv as never, input.runId).catch(() => false);
    if ((lateHold !== null && lateHold > Date.now()) || lateBreaker || latePaused) {
      state.releaseWriterSlot?.(); state.releaseWriterSlot = undefined;
      const reason = lateHold !== null && lateHold > Date.now()
        ? `waiting: held until ${lateHold >= HOLD_FOREVER ? "released" : new Date(lateHold).toISOString()}`
        : `waiting: ${lateBreaker ?? "the run is paused"}; starts by itself once it clears`;
      recordStage(db, { runId:input.runId, taskId:input.taskId, stageId:"writer-agent", state:"pending", input:input.plan, reason });
      return waitForAdmission(deps, state, input);
    }
    // The permit (SMA ac_permit), re-read at the seat like the holds above: a retry dispatches no lint, so the price and
    // the run's spend reserve are checked again here — a task that no longer fits ends blocked, uncharged.
    const permit = writerPermit(deps, state, input);
    if (permit) {
      state.releaseWriterSlot?.(); state.releaseWriterSlot = undefined;
      blockBeforeWriter(deps, state, input, permit);
      return false;
    }
    // Recovery state (SMA ac_recovery): nothing retries an attempt whose recovery is unfinished — a reconcile in
    // flight or a failed rollback settles first; the refusal names the state.
    const recovery = recoveryState(db, state.attemptId);
    if (recovery === "reconciling" || recovery === "rollback_failed") {
      state.releaseWriterSlot?.(); state.releaseWriterSlot = undefined;
      blockBeforeWriter(deps, state, input, `recovery_unfinished:${recovery}: the attempt's recovery is unfinished; settle it before this work is retried`);
      return false;
    }
    return true;
  };
  /** Admission passed: take the live-writer key, reload a corrected contract, open the running stage. */
  export const admitTask = async (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput):Promise<boolean> => {
  const { ctx, admitted } = deps;
  const { db, markCanceledWriterStages, refreshRun } = ctx;
    admitted.set(state.key, { runId:input.runId, taskId:input.taskId, projectId:input.projectId });
    const latestAttempt=getAttempt(db,state.attemptId);
    if(!latestAttempt||["canceled","blocked","accepted"].includes(latestAttempt.state)){
      if(latestAttempt?.state==="canceled"){
        markCanceledWriterStages(latestAttempt,"writer attempt canceled while waiting for provider pool");
        refreshRun(input.runId);
      }
      return false;
    }
    // A queued task the PM corrected with lane_pilot_update_task starts from the stored contract and plan, not the
    // ones it was dispatched with (live sandbox 2026-10-07: the writer ran the old plan after an update).
    const storedTask=taskV2Schema.safeParse(getTask(db,input.taskId)?.contract);
    const storedPlan=getTaskPlan(db,input.taskId);
    if(!state.writerThreadId&&storedTask.success&&storedTask.data.id===input.taskId) {
      input.task={...storedTask.data,project_cwd:input.task.project_cwd};
      if(storedPlan&&storedPlan.trim()) input.plan=storedPlan;
      state.activeTask=input.task;
      ({ task:state.freshTask, config:state.freshConfig } = freshAttemptStart(input.task, input.config, taskBasePath(db, input.runId, input.taskId)));
    }
    recordStage(db, { runId:input.runId, taskId:input.taskId, stageId:"writer-agent", state:"running",
      input:input.plan, attempt:countAttempts(db, input.runId, input.taskId) });
    return true;
  };
