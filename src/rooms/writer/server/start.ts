import { retryBudgetReason, spendRetryBudget } from "../retry-budget";
import { pilotOf, pilotUnderWall, runTasks } from "../../pilot";
import { breakerKey, budgetStopReason, classifyFailure, runningWriterBudgetStop, tokenUsageFromEvent, type RunBudget } from "@lane-pilot/resilience";
import type { DirtSnapshot } from "../cli-outcome";
import type { PrototypeConfig, TaskV2 } from "../../contracts";
import { providerPoolCap } from "@lane-pilot/settings-catalog";
import { isZcodeProvider, WRITER_PROFILES, type WriterProfile } from "@lane-pilot/models";
import { DEPENDENCY_REDO_WAIT_MS, countAttempts, countChargedAttempts, countThreadTurns, createAttempt, endSpawnFailure, getAttempt, getReasoningTrace, getRun, getRunSettingsScopes, getTask, getTaskPlan, latestTaskAttemptState, listAttemptsForTask, listOpenAttempts, listStageReceipts, listUnansweredWriterQuestions, loadProjectSettings, noteToldPmDirectly, transitionAttempt, taskBasePath } from "../../storage";
import { taskV2Schema } from "../../contracts";
import { ownsPathsOverlap, pollPause } from "@lane-pilot/kit";
import { reconcile, reconcileCursor } from "../../stability";
import { emergencyFallbackDecision } from "../../night";
import { rotatedWriterSettings, writerFallbackChain, writerFallbacks } from "../writer-fallbacks";
import { writerPickOverlay, type WriterLoad } from "../writer-model-pick";
import { reassignedReason, takeReassignRequest, type ReassignRequest } from "./reassign";
import { usageHoldReason, usageSkipPercent } from "../../usage/server";
import { MAIN_ATTEMPT_LIMIT, RETRY_ELIGIBLE } from "../../runs";
import { FREE_RETRY_LIMIT, PARKED_CLASSES, REPLAY_CHECK_FAILED, SESSION_MAX_MS, VERIFICATION_TIMEOUT_RETRIES, isWaitingSecret, isWriterSilent, repeatedFailureReason, taskFamily, turnFailureKey, verificationTimeoutOverBudget } from "../../runs";
import { isTaskSatisfied } from "../../runs/server";
import { isWriterStreamError, previousAttemptBrief } from "./writer-task";
import { stickyTurnPromptWithRules } from "./writer-knowledge";
import { parseMemorySettings } from "../../memory";
import { isMainfixTask, ownsFromOuterBase, retargetTask , priorityRank, HOLD_FOREVER, laneCap, laneQueueOf } from "../../tasks";
import { openDatabase } from "../../storage";
import { createWriterSticky } from "./sticky";
import { WRITER_QUESTION_WAIT_TEXT } from "./question-default";
import { failureClass, type FailureClass } from "../../runs";
import { jev } from "@lane-pilot/jev";
import { judgedFailureClass } from "../../runs";
import { isRunHalted, waitWhileRunPaused } from "../../runs/server";
import { allowedSecretNames, secretProblem, waitingSecretNote, waitingSecretReason } from "../../secrets/server";

/** How long a task waits for a blocked dependency to be sent again and accepted. */
/** How long a task waits for an Env Catalog secret, and how often it asks the catalog (BB sends no server-side event when it changes). */
const SECRET_WAIT_MS = 12 * 3600_000;
const secretPollMs = () => Number(process.env.LANE_PILOT_SECRET_POLL_MS) || 20_000;
import type { AttemptState } from "../../runs";
import { closeWriterStages, recordStage } from "../../runs/server";
import { id, stringAt } from "../../core/server";
import { shouldMergeAttemptWorktree } from "./spawn";
import { collectHandoffBrief } from "./writer-handoff";
import { listReturns, renderReturnNotes } from "../../stage-return";
import { isLiveDecision, LIVE_FOLDER_RECEIPT } from "../live-folder";
import { resolve } from "node:path";
import { findThreadsByMetadata } from "../../core/server";
import type { ServerCore } from "../../core/server";
import type { Services } from "../../core/server";
import { sendServiceMessage } from "../../relay/server";

/** Where a new attempt of the task starts: the run's workspace, whatever worktree a resumed attempt was bound to. */
export function freshAttemptStart(task:TaskV2, config:PrototypeConfig, runWorkspace:string|null):{task:TaskV2;config:PrototypeConfig} {
  if (!runWorkspace || resolve(task.project_cwd) === resolve(runWorkspace)) return { task, config };
  return {
    task:retargetTask(task,runWorkspace),
    config:{...config,writerWorkspacePath:runWorkspace},
  };
}

/** The latest charged failure of a task's family (its redispatches and mainfixes), to seed the repeated-failure stop. */
export function familyFailureRecord(db:ReturnType<typeof openDatabase>, runId:string, taskId:string):{ state:string; reason:string|null } | null {
  const family = taskFamily(taskId);
  const rows = db.prepare(`SELECT task_id, state, reason FROM lane_pilot_attempt
    WHERE run_id=? AND state IN ('provider_error','timeout','empty_output','validation_failed','spawn_rejected')
    ORDER BY created_at`).all(runId) as Array<{ task_id:string; state:string; reason:string|null }>;
  const other = rows.filter((row) => row.task_id !== taskId && taskFamily(row.task_id) === family);
  const last = other.at(-1);
  return last ? { state:last.state, reason:last.reason } : null;
}

/** A failure that was the task's own (a stray file, a red check), not its provider's, Lane Pilot's or the machine's. */
const isOwnFailure = (outcome:Record<string, unknown>) =>
  ["task", "contract"].includes(failureClass(String(outcome.status), typeof outcome.reason === "string" ? outcome.reason : null));

/**
 * The task's last own failure before this start (a retry from the board, a restart of a parked task, a reload): a writer
 * that starts fresh was told nothing of it and redid it (vf-s4-items 2026-10-24, «owns_paths rejected …/Buffs.luau» twice).
 * An acceptance since then clears it.
 */
function lastOwnFailure(db:ReturnType<typeof openDatabase>, runId:string, taskId:string, exceptAttemptId:string):Record<string, unknown>|null {
  const rows = db.prepare("SELECT id, state, reason FROM lane_pilot_attempt WHERE run_id=? AND task_id=? ORDER BY created_at DESC, rowid DESC")
    .all(runId, taskId) as Array<{ id:string; state:string; reason:string|null }>;
  for (const row of rows) {
    if (row.id === exceptAttemptId) continue;
    if (row.state === "accepted") return null;
    if (row.reason && isOwnFailure({ status:row.state, reason:row.reason })) return { status:row.state, reason:row.reason };
  }
  return null;
}

/** The tasks whose writer passed admission, per plugin instance: the files they own are theirs until their last attempt ends. */
const admittedByCore = new WeakMap<object, Map<string, { runId:string; taskId:string; projectId:string }>>();

export function createWriterStart(ctx: ServerCore, services: Services) {
  const { bb, db, effectiveProjectSettings, host, markCanceledWriterStages, refreshRun, runPolicyFor } = ctx;
  const sticky = createWriterSticky(ctx, services);
  const admitted = admittedByCore.get(ctx) ?? new Map<string, { runId:string; taskId:string; projectId:string }>();
  admittedByCore.set(ctx, admitted);

  /** The breaker learns from provider trouble only; the budget learns the thread's token total. */
  async function noteAttemptOutcome(input:{ budget:RunBudget; writerThreadId:string; writerSelection?:{providerId:string;model:string}; status:string; reason:string|null }): Promise<void> {
    if (input.writerSelection) {
      const key = breakerKey(input.writerSelection.providerId, input.writerSelection.model);
      const outcome = input.status === "accepted" || input.status === "validation_failed" || input.status === "empty_output"
        ? "ok"
        : classifyFailure(`${input.status}:${input.reason ?? ""}`);
      services.providerBreaker.record(key, outcome === "product" ? "ok" : outcome);
    }
    try {
      const listed = await bb.sdk.threads.events.list({ threadId:input.writerThreadId, types:["thread/tokenUsage/updated"], order:"desc", limit:"50" });
      const usage = Array.isArray(listed) ? tokenUsageFromEvent(listed[0]) : null;
      if (usage) input.budget.noteTokens(usage.threadId, usage.totalTokens);
    } catch {
      // Usage is informational; a host that cannot list events does not fail the attempt.
    }
  }

  /**
   * The chain entries whose provider usage window is not spent (provider-usage, I1); `room` says whether any is. When every
   * entry is spent the whole chain stays: the reading may be stale, and a spent window still fails in the provider's own
   * words, as before.
   */
  async function chainWithRoom<T extends { providerId:string; model:string }>(chain:T[], hostId:string, settings:Record<string, unknown>, taskId:string):Promise<{ chain:T[]; room:boolean }> {
    const threshold = usageSkipPercent(settings);
    // The usage threshold can be 0 (the windows off); ZCode's own limits (host, free hours, one slot) still hold.
    if (!chain.length || (threshold <= 0 && !chain.some((entry) => isZcodeProvider(entry.providerId)))) return { chain, room:chain.length > 0 };
    const holds = await Promise.all(chain.map((entry) => services.providerUsage.hold({ providerId:entry.providerId, model:entry.model, hostId, threshold, settings })));
    const usable = chain.filter((_, index) => !holds[index]);
    if (usable.length) chain.forEach((entry, index) => { if (holds[index]) ctx.log(`writer ${taskId}: ${entry.providerId}/${entry.model} skipped, ${usageHoldReason(entry.providerId, entry.model, holds[index]!)}`); });
    return usable.length ? { chain:usable, room:true } : { chain, room:false };
  }

  /** Jev's writer for a task, once per task (kept in the KV), as the settings it changes; null keeps the project's writer. */
  const pickWriter = (settings:Record<string, unknown>, input:{ projectId:string; runId:string; taskId:string; task:TaskV2; config:PrototypeConfig }) =>
    writerPickOverlay({ kv:bb.storage.kv as never, jev:jev(), log:(line) => bb.log.warn(line),
      // A writer whose provider window is spent (usage.skip_percent) is not offered to Jev; ZCode neither where it cannot work now (no zcode
      // provider on the task's machine, outside its free hours, or busy).
      held:async (profile) => Boolean(await services.providerUsage.hold({ providerId:profile.providerId, model:profile.model, hostId:input.config.hostId,
        threshold:isZcodeProvider(profile.providerId) ? 0 : usageSkipPercent(settings), settings })),
      load:(profiles) => writerLoad(profiles, input.config.hostId, settings) },
      settings, input);

  /**
   * How busy each offered writer's provider is, for Jev to spread the tasks: the spent share of its usage window (from the cached
   * readings; null when nothing is measured) and the writer tasks running on that provider now (the picks kept for running tasks).
   */
  async function writerLoad(profiles:readonly WriterProfile[], hostId:string, settings:Record<string, unknown>):Promise<Record<string, WriterLoad>> {
    // ponytail: counts only tasks whose writer Jev picked (a task on the project's own writer has no kept pick); count attempts by writer pair if that skews the spread.
    const running = new Map<string, number>();
    const picks = await Promise.all([...services.activeWriterTasks].map((key) => bb.storage.kv.get(`writer-pick:${key}`).catch(() => null)));
    for (const picked of picks) {
      const provider = typeof picked === "string" && picked ? WRITER_PROFILES.find((row) => row.key === picked)?.providerId : undefined;
      if (provider) running.set(provider, (running.get(provider) ?? 0) + 1);
    }
    const out:Record<string, WriterLoad> = {};
    await Promise.all(profiles.map(async (profile) => {
      const spent = isZcodeProvider(profile.providerId) ? null
        : await services.providerUsage.hold({ providerId:profile.providerId, model:profile.model, hostId, threshold:1, settings }).catch(() => null);
      out[profile.key] = { percent:spent?.percent ?? null, running:running.get(profile.providerId) ?? 0 };
    }));
    return out;
  }

  function startWriterTask(input:{
    projectId:string; runId:string; taskId:string; firstAttemptId:string; pmThreadId:string;
    config:PrototypeConfig; task:TaskV2; plan:string; writerThreadId?:string; dirtBefore?:DirtSnapshot[]; pmReadContext?:string;
    /** The writer already has its turn in writerThreadId (the PM reopened the attempt): it is checked once the turn ends, without the waits. */
    turnSent?:boolean;
  }): void {
    const key = `${input.runId}:${input.taskId}`;
    if (services.activeWriterTasks.has(key)) return;
    services.activeWriterTasks.add(key);
    let attemptId = input.firstAttemptId;
    let writerThreadId = input.writerThreadId;
    let writerSelection:{providerId:string;model:string;reasoningLevel?:string;serviceTier?:"default"|"fast"|null;selectionSource?:{providerId:string;model:string;reasoningLevel:string;serviceTier:"default"|"fast"|null;reasoningLevelSource:"explicit"|"client-preference"}}|undefined;
    const existingTrace=getReasoningTrace(db,attemptId);
    if(existingTrace) writerSelection={
      providerId:existingTrace.providerId, model:existingTrace.model,
      reasoningLevel:existingTrace.effectiveReasoningLevel, serviceTier:existingTrace.serviceTier,
      selectionSource:existingTrace.selectionSource,
    };
    // An attempt resumed after a reload arrives bound to its own worktree. Every new attempt starts from the run's
    // workspace instead: that worktree is removed when the attempt fails, and a retry snapshotted inside it failed
    // with «spawnSync /bin/bash ENOENT» (project-folders, 2026-10-02).
    let { task:freshTask, config:freshConfig } = freshAttemptStart(input.task, input.config, taskBasePath(db, input.runId, input.taskId));
    let activeConfig = input.config;
    let activeTask = input.task;
    // An attempt that never reached a writer has no baseline: its stored [] is the column's default. Taken as the folder's
    // state, a parked task restarted on a new attempt counted every file of a folder without git as its writer's change
    // (BB-сервис 2026-10-10: 49 434 paths, three tasks failed as Lane Pilot's fault).
    const resumedDirt = getAttempt(db, input.firstAttemptId)?.thread_id ? input.dirtBefore : undefined;
    let dirtBefore = resumedDirt ?? [];
    let baselineDirtBefore:DirtSnapshot[]|null=resumedDirt?[...resumedDirt]:null;
    let baselineWorkspacePath:string|null=resumedDirt?input.task.project_cwd:null;
    let executionPacketSha256:string|null = null;
    let last: Record<string, unknown> = {};
    // The class Jev (J-4, active) or the rules gave the last failure: parking reads the same one, not its own recount.
    let judged: { status: string; reason: string | null; klass: FailureClass } | null = null;
    let primaryFailure:Record<string,unknown>|null=null;
    /** A red check the same writer already failed the same way: the next attempt is the next writer, not this one again. */
    let checkEscalation:string|null=null;
    /** The last failure that was the task's own (a stray file, a red check), not its provider's: a fallback writer avoids it too. */
    const own:{ failure:Record<string,unknown>|null } = { failure:lastOwnFailure(db, input.runId, input.taskId, input.firstAttemptId) };
    const noteOwnFailure = (outcome:Record<string,unknown>) => { if (isOwnFailure(outcome)) own.failure = outcome; };
    // The PM reassigned the task: the next writer continues the stopped one's worktree and starts with the requested model.
    let pendingReassign:{from:ReturnType<typeof getAttempt>; request:ReassignRequest}|null=null;
    // The last failed attempt's worktree, kept until the next attempt starts or the fallback chain takes it over.
    let unremovedWorktree:ReturnType<typeof getAttempt>=undefined;
    // An earlier task of the same family (a redispatch, a mainfix) that failed the same way stops the next one early.
    let familyFailure = familyFailureRecord(db, input.runId, input.taskId);
    let acceptedAttemptId:string|null=null;
    const pmReadContext=input.pmReadContext ?? stringAt(listStageReceipts(db,input.runId,input.taskId).find((row)=>row.stageId==="pm-read")?.result,"summary") ?? "";
    let releaseWriterSlot:(()=>void)|undefined;
    // This start owns the live-writer key until it drops it. A question drops the key before the cleanup
    // awaits (a worktree remove can hang); the finally still frees the pool slot, and must not delete a key
    // a later answer's start has taken.
    let holdsLiveWriter = true;
    const dropLiveWriterKey = () => {
      if (!holdsLiveWriter) return;
      holdsLiveWriter = false;
      admitted.delete(key);
      services.activeWriterTasks.delete(key);
    };
    // A folder without git: one writer at a time edits its live files, and a failed attempt is rolled back from the
    // backup its first spawn made (feedback turns in the same thread keep working on the live files, so they keep it).
    let liveFolder = false;
    let liveBackupId:string|null = null;
    /** The backup an attempt works under, kept so an attempt resumed later (the PM's answer, a reload) finds it. */
    const liveBackupKey = (forAttemptId:string) => `live-backup:${forAttemptId}`;
    const bindLiveBackup = async ():Promise<void> => {
      if (liveBackupId) await bb.storage.kv.set(liveBackupKey(attemptId), liveBackupId as never).catch(() => undefined);
    };
    /** Puts the owned files back after a failed attempt and takes out what the writer created there; once per backup. */
    const rollbackLive = async ():Promise<void> => {
      const backupId = liveBackupId;
      if (!backupId) return;
      // A writer's question is a pause, not a rejection: its answer continues the same attempt on the files as it left them.
      if (failureClass(String(last.status), typeof last.reason === "string" ? last.reason : null) === "judgment") return;
      liveBackupId = null;
      const folder = taskBasePath(db, input.runId, input.taskId) ?? input.task.project_cwd;
      const rolled = await services.restoreLiveFolder({ hostId:input.config.hostId, folder, backupId, task:freshTask })
        .catch((cause:unknown) => ({ ok:false as const, reason:cause instanceof Error ? cause.message : String(cause) }));
      if (rolled.ok && !rolled.failed.length) {
        ctx.log(`writer ${input.taskId}: rolled back ${backupId}: ${rolled.restored.length} restored, ${rolled.removed.length} removed`);
        return;
      }
      const why = rolled.ok ? `could not put back ${rolled.failed.join("; ")}` : rolled.reason;
      ctx.log(`writer ${input.taskId}: rollback of ${backupId} incomplete: ${why}`);
      if (input.pmThreadId) void bb.sdk.threads.send({ threadId:input.pmThreadId, mode:"queue-if-active", input:[{ type:"text", mentions:[],
        text:`Lane Pilot: task ${input.taskId} was not accepted and its files in ${folder} could not be put back automatically (${why.slice(0, 600)}). The originals are in ~/.lane-pilot/live-backups/${backupId}/files on the folder's machine; tell the owner before another task runs there.` }] } as never).catch(() => undefined);
    };
    /**
     * depends_on: the task starts only once every task it names is accepted (its work is in main). A blocked
     * dependency is usually fixed and sent again (`<id>.2`), which the name follows, so the task keeps waiting for it
     * up to six hours instead of failing at once and making the PM resend the whole chain (SelfyStudio 2026-10-04).
     * A canceled dependency, or a name no one dispatched, ends the wait at once.
     */
    const waitForDependencies = async (shouldStop?:()=>string|null): Promise<string | null> => {
      // The pilot of this task's siblings (src/rooms/pilot): waited for like a dependency, except that a canceled pilot holds no one.
      const waveTasks = runTasks(db, input.runId);
      const pilot = pilotOf(input.taskId, waveTasks);
      // A blocked pilot that nothing will redo soon (its own attempts are spent, or the wall ladder holds its family or a hunt runs on its
      // files) holds no one: the wave goes on in its own order, each task still serialised by owns_paths overlap. Only the PM's own depends_on keeps the 6-hour wait.
      const pilotGivenUp = (dep:string) => countChargedAttempts(db, input.runId, dep) >= MAIN_ATTEMPT_LIMIT
        || pilotUnderWall(db, input.runId, taskFamily(dep), waveTasks.find((task) => task.id === dep)?.ownsPaths ?? []);
      const deps = [...new Set([...(input.task.depends_on ?? []), ...(pilot ? [pilot] : [])].filter((dep) => dep && dep !== input.taskId))];
      let noted = "";
      const since = Date.now();
      const blockedSince = new Map<string, number>();
      const released = new Set<string>();
      for (;;) {
        if (ctx.isDisposed()) return null;
        const stop = shouldStop?.();
        if (stop) return stop;
        const pending: string[] = [];
        for (const dep of deps) {
          const state = latestTaskAttemptState(db, input.projectId, dep);
          if (state === "accepted") continue;
          // A batch may dispatch the dependent before its dependency: give the name two minutes to appear.
          if (state === null && Date.now() - since > 120_000) return `depends_on ${dep}: no such task was dispatched in this project`;
          if (state === "canceled" && dep === pilot && !(input.task.depends_on ?? []).includes(dep)) continue;
          if (state === "canceled") return `depends_on ${dep}: that task ended canceled`;
          if (state === "blocked") {
            // The PM verified this blocked task by hand (lane_pilot_update_task satisfied:true): its dependents go on.
            if (await isTaskSatisfied(bb.storage.kv as never, input.projectId, dep)) continue;
            if (dep === pilot && !(input.task.depends_on ?? []).includes(dep) && pilotGivenUp(dep)) {
              if (!released.has(dep)) { released.add(dep); ctx.log(`writer ${input.taskId} goes on: its pilot ${dep} ended blocked and nothing will redo it soon`); }
              continue;
            }
            blockedSince.set(dep, blockedSince.get(dep) ?? Date.now());
            if (Date.now() - blockedSince.get(dep)! > DEPENDENCY_REDO_WAIT_MS) return `depends_on ${dep}: that task ended blocked and was not sent again within 6 hours`;
          } else blockedSince.delete(dep);
          pending.push(dep);
        }
        if (!pending.length) return null;
        // The text names which dependencies ended blocked; a restart of one of them changes it, so it is part of the key.
        const key = `${pending.join(",")}|${pending.filter((dep) => blockedSince.has(dep)).join(",")}`;
        if (noted !== key) {
          noted = key;
          ctx.log(`writer ${input.taskId} waits for depends_on ${pending.join(",")}`);
          const stage = listStageReceipts(db,input.runId,input.taskId).find((row) => row.stageId === "writer-agent");
          if (!stage || stage.state === "pending") {
            const redo = pending.filter((dep) => blockedSince.has(dep));
            recordStage(db, { runId:input.runId, taskId:input.taskId, stageId:"writer-agent", state:"pending", input:input.plan,
              reason:`${redo.length ? `waiting for depends_on: ${pending.join(",")} (${redo.join(", ")} ended blocked; starts once it is sent again and accepted)` : `waiting for depends_on: ${pending.join(",")}`}${pilot && pending.includes(pilot) ? ` (${pilot} is the pilot of its area: the siblings start once it is accepted)` : ""}` });
          }
        }
        await new Promise((wake) => setTimeout(wake, pollPause(10_000)));
      }
    };
    /**
     * The secrets the task's checks declare must be in Env Catalog and allowed before a writer starts (J6): a writer would
     * do the work and then fail the checks for want of them. The task waits with the stage reason `waiting_secret:NAME`,
     * no attempt is spent, the PM is told once what to do (env_request), and the wait ends by itself when the access is
     * in place. Env Catalog's change event reaches only the app, so the catalog is asked every 20 seconds meanwhile.
     */
    const waitForSecrets = async (shouldStop?:()=>string|null): Promise<string | null> => {
      const declared = [...new Set(input.task.verification.flatMap((check) => check.secrets ?? []))];
      if (!declared.length) return null;
      const since = Date.now();
      let noted = "";
      for (;;) {
        if (ctx.isDisposed()) return null;
        const stop = shouldStop?.();
        if (stop) return stop;
        const latest = getAttempt(db, attemptId);
        if (!latest || ["canceled", "blocked", "accepted"].includes(latest.state)) return null;
        const gate = await ctx.secrets.check({ declared, allowed:allowedSecretNames(loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId))) }, { fresh:true });
        const names = secretProblem(gate);
        if (!names.length && !gate.unavailable) return null;
        const reason = waitingSecretReason(names.length ? names : declared);
        if (noted !== reason) {
          noted = reason;
          ctx.log(`writer ${input.taskId} waits: ${reason}`);
          recordStage(db, { runId:input.runId, taskId:input.taskId, stageId:"writer-agent", state:"pending", input:input.plan, reason });
          if (input.pmThreadId) void bb.sdk.threads.send({ threadId:input.pmThreadId, mode:"queue-if-active", input:[{ type:"text", mentions:[], text:waitingSecretNote(input.taskId, gate) }] } as never).catch(() => undefined);
        }
        if (Date.now() - since > SECRET_WAIT_MS) return `${reason}: not provided within 12 hours; send the task again once it is saved`;
        await new Promise((wake) => setTimeout(wake, secretPollMs()));
      }
    };
    const waitForOverlappingTasks = async (shouldStop?:()=>string|null) => {
      // Tasks queue behind each other in the same checkout only: another repository of the same folder is another checkout.
      const base = taskBasePath(db, input.runId, input.taskId);
      /** Another task of this folder that ended with a question nobody has answered; a halted run (the owner stopped it) holds nothing. */
      const unansweredQuestionHolder = async () => {
        for (const row of listUnansweredWriterQuestions(db)) {
          if (row.task_id === input.taskId || row.project_id !== input.projectId) continue;
          if (base && taskBasePath(db, row.run_id, row.task_id) !== base) continue;
          if (await isRunHalted(bb.storage.kv as never, row.run_id)) continue;
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
        const mine = open.findIndex((row) => row.id === attemptId);
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
        const blocker = ahead.find((row) => {
          if (row.task_id === input.taskId || row.project_id !== input.projectId) return false;
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
          if (base && rowBase !== base) {
            const pair = rowBase && parsed.success ? ownsFromOuterBase(base, input.task.owns_paths, rowBase, parsed.data.owns_paths) : null;
            return Boolean(pair && ownsPathsOverlap(pair[0], pair[1]));
          }
          // One writer at a time per area: the next task of a page continues in its writer's thread once it is free.
          if (liveFolder) return true;
          if (parsed.success && sameArea(parsed.data.area, input.task.area)) return true;
          return parsed.success && ownsPathsOverlap(parsed.data.owns_paths, input.task.owns_paths);
        });
        // A writer's question is a pause, not a release: its files are still in the folder without git, and its answer goes on
        // from them, so no other task may start there until the question is answered (or the task is sent again).
        const asked = !blocker && liveFolder ? await unansweredQuestionHolder() : undefined;
        const holder = blocker ?? asked;
        if (!holder) return;
        const why = asked ? "its writer's question is unanswered and the folder has no git, so it stays locked until lane_pilot_answer_writer answers it"
          : liveFolder ? "one writer at a time in a folder without git" : "their owns_paths overlap";
        if (noted !== holder.id) {
          noted = holder.id;
          ctx.log(`writer ${input.taskId} waits for ${holder.task_id}: ${why}`);
          const stage = listStageReceipts(db,input.runId,input.taskId).find((row) => row.stageId === "writer-agent");
          if (!stage || stage.state === "pending") {
            recordStage(db, { runId:input.runId, taskId:input.taskId, stageId:"writer-agent", state:"pending", input:input.plan,
              reason:`waiting for ${holder.task_id} (thread ${holder.thread_id ?? "not started"}): ${liveFolder ? why : `${input.task.area ? "same area or " : ""}owns_paths overlap`}` });
          }
        }
        await new Promise((wake) => setTimeout(wake, 10_000));
      }
    };
    /** Gives up the threads of this task's failed attempts: provider-retry's queued retries in them are cancelled (I2). */
    const releaseFailedThreads = async () => {
      for (const row of listAttemptsForTask(db, input.runId, input.taskId)) {
        if (row.thread_id && row.state !== "accepted") await services.providerRetry.abandon(row.thread_id);
      }
    };
    /** Removes a failed attempt's own worktree; a worktree that is the run folder, or a BB environment, is left alone. */
    const removeWorktreeOf = async (failed:ReturnType<typeof getAttempt>) => {
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
    void (async () => {
      const policy=runPolicyFor(input.runId);
      // The writer for this task: Jev's pick from the writers' anamnesis, else the rotation's share, else the project's writer; every
      // attempt of the task sees the same pair (the pick is kept per task).
      const baseSettings=(await effectiveProjectSettings(input.projectId,getRunSettingsScopes(db,input.runId))).values;
      const writerOverlay=await pickWriter(baseSettings, input);
      const runSettings=writerOverlay ? { ...baseSettings, ...writerOverlay } : rotatedWriterSettings(baseSettings, input.taskId);
      // Only the writer keys travel to the spawn: the spawn reads the stored settings again, and must see this choice, not the project's.
      const writerChoice=Object.fromEntries(Object.entries(runSettings).filter(([key, value]) => key.startsWith("writer.") && value !== baseSettings[key]));
      const budget=services.runBudgetFor(input.runId,runSettings);
      const wallOrTokenStop = () => runningWriterBudgetStop(budget.check());
      const blockBeforeWriter = (reason:string) => {
        transitionAttempt(db, attemptId, "blocked", { reason });
        last = { status:"blocked", reason, attemptId };
        closeWriterStages(db, { runId:input.runId, taskId:input.taskId, plan:input.plan, terminal:"failed",
          attempt:countAttempts(db, input.runId, input.taskId), reason });
        refreshRun(input.runId);
      };
      // Tasks run side by side only when they cannot touch the same files: one whose owns_paths overlap an
      // earlier open task's (in any run on the same checkout) waits for it, instead of conflicting at the merge.
      const runFolder = taskBasePath(db, input.runId, input.taskId) ?? input.task.project_cwd;
      liveFolder = await services.isLiveFolder(input.runId, input.config.hostId, runFolder);
      // An attempt resumed on its writer's thread (the PM's answer, a reload) goes on under the backup it began with.
      if (liveFolder && writerThreadId) {
        const saved = await bb.storage.kv.get(liveBackupKey(attemptId)).catch(() => null);
        if (typeof saved === "string") liveBackupId = saved;
      }
      /** The waits a task passes before its writer gets a turn: depends_on, overlapping tasks, secrets, the breaker and the pools. */
      const waitForAdmission = async (): Promise<boolean> => {
        // A paused run lets nothing new start (bb lane-pilot pause): the task waits here, before it takes any slot, and goes on by itself on resume.
        if (!await waitWhileRunPaused(bb.storage.kv as never, input.runId, { isDisposed: ctx.isDisposed, onFirstWait: () => {
          ctx.log(`writer ${input.taskId} waits: run ${input.runId} is paused`);
          recordStage(db, { runId:input.runId, taskId:input.taskId, stageId:"writer-agent", state:"pending", input:input.plan,
            reason:"waiting: the run is paused; starts by itself once it is resumed" });
        } })) return false;
        // Held until a date (2999 = until released): the task stays queued and takes no slot (lane_pilot_queue {action:"hold"}).
        for (let noted = false; !ctx.isDisposed();) {
          const held = (db.prepare("SELECT held_until FROM lane_pilot_task WHERE id=?").get(input.taskId) as { held_until: number | null } | undefined)?.held_until ?? null;
          if (!held || held <= Date.now()) break;
          if (!noted) {
            noted = true;
            recordStage(db, { runId:input.runId, taskId:input.taskId, stageId:"writer-agent", state:"pending", input:input.plan,
              reason:`waiting: held until ${held >= HOLD_FOREVER ? "released" : new Date(held).toISOString()}` });
          }
          await new Promise((wake) => setTimeout(wake, pollPause(10_000)));
        }
        const dependency = await waitForDependencies(wallOrTokenStop);
        if (dependency) {
          blockBeforeWriter(dependency);
          return false;
        }
        const overlapStop = await waitForOverlappingTasks(wallOrTokenStop);
        if (overlapStop) {
          blockBeforeWriter(overlapStop);
          return false;
        }
        const secretStop = await waitForSecrets(wallOrTokenStop);
        if (secretStop) {
          blockBeforeWriter(secretStop);
          return false;
        }
        // Several tasks failed on the same Lane Pilot fault just now, or the disk is nearly full: starting more only burns them too.
        for (let noted = ""; ;) {
          if (ctx.isDisposed()) return false;
          const budgetStop = wallOrTokenStop();
          if (budgetStop) { blockBeforeWriter(budgetStop); return false; }
          // An attempt canceled while it waits stops waiting: the drill's canceled writers kept polling the full Mac mini disk and
          // logging for half an hour after their cancel (2026-10-27, drill-20261027-023238-memory, drill-pm-20261027-note).
          const waiting = getAttempt(db, attemptId);
          if (!waiting || ["canceled", "blocked", "accepted"].includes(waiting.state)) {
            if (waiting?.state === "canceled") {
              markCanceledWriterStages(waiting, "writer attempt canceled while it waited for room");
              refreshRun(input.runId);
            }
            return false;
          }
          const base = taskBasePath(db, input.runId, input.taskId);
          // Money and the subscription window: a paid lane over the month's cap, or a Claude window at 98%, waits (src/rooms/money).
          const moneyProvider = typeof runSettings["writer.provider"] === "string" && runSettings["writer.provider"] ? runSettings["writer.provider"] as string : input.config.writerProviderId;
          const moneyModel = typeof runSettings["writer.model"] === "string" ? runSettings["writer.model"] as string : "";
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
        releaseWriterSlot=liveFolder
          ? await services.runWriterPool.acquire(`live-folder:${input.config.hostId}:${resolve(runFolder)}`,1)
          : await services.runWriterPool.acquire(input.runId,policy.pools.provider,priorityRank(input.task.priority));
        // BB's concurrency-limit plugin caps the threads a host runs at once: writers beyond it would only wait in BB's queue,
        // so they wait here, before their attempt starts (no pool slot is held by a writer that cannot run). No plugin, no cap.
        const hostCap = await services.concurrencyLimit.hostCap(input.config.hostId);
        if (hostCap !== null && !liveFolder) {
          const releaseRunSlot = releaseWriterSlot;
          const releaseHostSlot = await services.runWriterPool.acquire(`concurrency-limit:${input.config.hostId}`, Math.min(hostCap, 15));
          releaseWriterSlot = () => { releaseHostSlot(); releaseRunSlot?.(); };
        }
        // G9: a cap on simultaneous writers of one provider (ops.provider_pool); a task over it waits here, queued, not failed.
        // It counts the task's writer provider; a fallback of the chain is not counted. No entry, no cap.
        const poolProvider = typeof runSettings["writer.provider"] === "string" && runSettings["writer.provider"] ? runSettings["writer.provider"] as string : input.config.writerProviderId;
        const providerCap = providerPoolCap(runSettings, poolProvider);
        if (providerCap !== null && !liveFolder) {
          const releaseHeld = releaseWriterSlot;
          const releaseProviderSlot = await services.runWriterPool.acquire(`provider-pool:${poolProvider}`, providerCap);
          releaseWriterSlot = () => { releaseProviderSlot(); releaseHeld?.(); };
        }
        // Four lane queues: writing, checks, docs and research each wait in their own queue when the project caps it (queue.lane_caps).
        const lane = laneQueueOf(input.task.kind);
        const capOfLane = laneCap(runSettings["queue.lane_caps"], lane);
        if (capOfLane !== null && !liveFolder) {
          const releaseHeld = releaseWriterSlot;
          const releaseLaneSlot = await services.runWriterPool.acquire(`lane-queue:${input.projectId}:${lane}`, capOfLane, priorityRank(input.task.priority));
          releaseWriterSlot = () => { releaseLaneSlot(); releaseHeld?.(); };
        }
        return true;
      };
      // An attempt the PM reopened (an answer to the writer's question, a contract fix) passed these waits when it first
      // started, and its turn is already in the writer's thread: the writer works whatever Lane Pilot waits for here.
      // Waiting again only held back its checks: a reopened attempt is created as a retry, later than the siblings queued
      // behind it, so it queued behind them while its writer had long finished (SelfyStudio 2026-10-15: stickers-landing-
      // showcase and webapp-ideas-home «running» about an hour with an idle writer).
      if (!input.turnSent && !await waitForAdmission()) return;
      admitted.set(key, { runId:input.runId, taskId:input.taskId, projectId:input.projectId });
      const latestAttempt=getAttempt(db,attemptId);
      if(!latestAttempt||["canceled","blocked","accepted"].includes(latestAttempt.state)){
        if(latestAttempt?.state==="canceled"){
          markCanceledWriterStages(latestAttempt,"writer attempt canceled while waiting for provider pool");
          refreshRun(input.runId);
        }
        return;
      }
      // A queued task the PM corrected with lane_pilot_update_task starts from the stored contract and plan, not the
      // ones it was dispatched with (live sandbox 2026-10-07: the writer ran the old plan after an update).
      const storedTask=taskV2Schema.safeParse(getTask(db,input.taskId)?.contract);
      const storedPlan=getTaskPlan(db,input.taskId);
      if(!writerThreadId&&storedTask.success&&storedTask.data.id===input.taskId) {
        input.task={...storedTask.data,project_cwd:input.task.project_cwd};
        if(storedPlan&&storedPlan.trim()) input.plan=storedPlan;
        activeTask=input.task;
        ({ task:freshTask, config:freshConfig } = freshAttemptStart(input.task, input.config, taskBasePath(db, input.runId, input.taskId)));
      }
      recordStage(db, { runId:input.runId, taskId:input.taskId, stageId:"writer-agent", state:"running",
        input:input.plan, attempt:countAttempts(db, input.runId, input.taskId) });
      // A merge conflict or a fault of Lane Pilot or the machine does not spend an attempt; free retries are capped too.
      // Free retries are counted within this start: a task restarted after a Lane Pilot fix gets its full share,
      // while attempts burned on the fault before it stay out of the count (BB-сервис 2026-10-05: five fault attempts
      // left the restarted task no attempt at all, and it sat queued with its stages failed).
      let attemptsHere = 0;
      const attemptsLeft = () => countChargedAttempts(db, input.runId, input.taskId) <= MAIN_ATTEMPT_LIMIT
        && attemptsHere < MAIN_ATTEMPT_LIMIT + FREE_RETRY_LIMIT;
      let halfBound = false;
      // A task is ONE writer session: a failure of the task's own goes back to the same writer as a feedback turn (a new
      // attempt row in its thread, not a new charged attempt) until the checks pass, the turn cap (SESSION_MAX_TURNS) or
      // the wall cap (SESSION_MAX_MS) is reached, or two turns in a row leave both the failure and the diff unchanged.
      // Only a provider or limit fault, or a thread that cannot take the turn, starts another writer.
      let inSession = false;
      let sessionStartedAt = Date.now();
      let previousTurn:{ failure:string; diff:string|null; streamError?:boolean } | null = null;
      /** Another attempt follows this failure: the same conditions the loop checks below before it creates one. */
      const attemptsLeftAfter = (binding:ReturnType<typeof getAttempt>) => Boolean(binding?.thread_id)
        && RETRY_ELIGIBLE.includes(String(last.status) as AttemptState)
        && countChargedAttempts(db, input.runId, input.taskId) < MAIN_ATTEMPT_LIMIT
        && attemptsHere + 1 < MAIN_ATTEMPT_LIMIT + FREE_RETRY_LIMIT;
      /** Takes over an existing writer thread for this attempt; false leaves the attempt to a fresh spawn. */
      const continueWith = async (writer:NonNullable<Awaited<ReturnType<typeof sticky.hotWriter>>>, kind:"next-task"|"retry"|"merge", previousAttempt:string, keepDirt?:DirtSnapshot[]):Promise<boolean> => {
        const bound = retargetTask(freshTask,writer.workspacePath);
        // The next task of an area is a different contract: its rules come with it (writer-knowledge.ts); a retry or a merge keeps the brief's.
        const memorySettings = parseMemorySettings((await effectiveProjectSettings(input.projectId, getRunSettingsScopes(db, input.runId)).catch(() => ({ values:{} }))).values);
        const turnPrompt = await stickyTurnPromptWithRules({ db, host, chainForRun:(runId) => services.ruleScan.chainForRun(runId) },
          { projectId:input.projectId, runId:input.runId, hostId:freshConfig.hostId, task:bound, memorySettings },
          { kind, task:bound, previousAttempt:kind === "merge" && !previousAttempt.includes(REPLAY_CHECK_FAILED) ? "" : previousAttempt, liveFolder });
        // A task a person sent back to an earlier stage with a note (src/rooms/stage-return) takes the note into the area writer's next-task turn.
        const returnNotes = kind === "next-task" ? renderReturnNotes(listReturns(db, input.runId, input.taskId)) : "";
        const turn = await sticky.continueInThread({ runId:input.runId, taskId:input.taskId, attemptId, config:freshConfig, writer, kind, dirtBefore:keepDirt,
          prompt:returnNotes ? (conflicts) => `${turnPrompt(conflicts)}\n\n${returnNotes}` : turnPrompt });
        if (!turn.ok) {
          ctx.log(`writer ${input.taskId}: ${kind} in thread ${writer.threadId} not possible (${turn.reason}); a fresh writer starts`);
          // A half-bound attempt cannot take a fresh spawn: it ends as Lane Pilot's fault and the retry spawns.
          if (turn.bound) {
            last = { status:endSpawnFailure(db, attemptId, turn.reason), reason:turn.reason, attemptId };
            halfBound = true;
          }
          return false;
        }
        writerThreadId = writer.threadId;
        const trace = getReasoningTrace(db, attemptId);
        writerSelection = trace ? { providerId:trace.providerId, model:trace.model, reasoningLevel:trace.effectiveReasoningLevel,
          serviceTier:trace.serviceTier, selectionSource:trace.selectionSource } : undefined;
        activeConfig = freshConfig;
        activeTask = bound;
        dirtBefore = turn.dirtBefore;
        baselineDirtBefore ??= [...turn.dirtBefore];
        baselineWorkspacePath ??= turn.workspacePath;
        executionPacketSha256 = null;
        return true;
      };
      // The baseline (src/rooms/baseline): the task's checks on the base before any writer is asked. «Already built» is told to the PM, or in
      // mode stop ends the task here with the evidence. A mainfix has its own preflight below; a folder without git has no base to run on.
      if (!writerThreadId && !input.turnSent && !liveFolder && !isMainfixTask(input.task.id)) {
        const baseline = await services.baseline?.preflight({ projectId:input.projectId, runId:input.runId, taskId:input.taskId, attemptId, pmThreadId:input.pmThreadId, config:freshConfig, task:freshTask });
        if (baseline?.stop) { blockBeforeWriter(baseline.stop); return; }
      }
      // The area's writer from an earlier task of this run takes this one in its own thread, unless the writer setting now names
      // another provider or model: then this task gets a fresh writer on the current one (the spawn's own selection, below).
      if (!writerThreadId && input.task.area && !liveFolder) {
        const wanted = {
          providerId: typeof runSettings["writer.provider"] === "string" ? runSettings["writer.provider"] as string : freshConfig.writerProviderId,
          model: typeof runSettings["writer.model"] === "string" && runSettings["writer.model"] ? runSettings["writer.model"] as string : freshConfig.writerModel,
        };
        const hot = await sticky.hotWriter(input.projectId, input.runId, input.task.area, wanted);
        if (hot) await continueWith(hot, "next-task", "");
      }
      while (attemptsLeft()) {
        // The stage that just ended is the safe boundary of a pause: the next attempt or turn waits for the resume.
        if (!await waitWhileRunPaused(bb.storage.kv as never, input.runId, { isDisposed: ctx.isDisposed, onFirstWait: () => ctx.log(`writer ${input.taskId} waits at a stage boundary: run ${input.runId} is paused`) })) return;
        if (!inSession) { attemptsHere += 1; sessionStartedAt = Date.now(); previousTurn = null; }
        const budgetCheck=budget.check();
        if (!budgetCheck.ok) {
          const reason=budgetStopReason(budgetCheck.exceeded);
          transitionAttempt(db, attemptId, "blocked", { reason });
          last = { status:"blocked", reason, attemptId };
          break;
        }
        // A mainfix runs only while main is still red: when its failing checks already pass on current main (another
        // task fixed it), it closes as accepted without a writer and the PM hears why.
        if (attemptsHere === 1 && !writerThreadId && isMainfixTask(input.task.id) && freshTask.verification.length > 0) {
          const checks = await services.runVerification(freshConfig, freshTask, input.runId).catch(() => null);
          if (checks && checks.length > 0 && checks.every((check) => check.exitCode === 0)) {
            ctx.log(`mainfix ${input.taskId}: its checks already pass on main; closing accepted without a writer`);
            transitionAttempt(db, attemptId, "accepted");
            last = { status:"accepted", attemptId, produced:[], verification:checks,
              mainfixPreflight:"the failing checks already pass on current main" };
            if (input.pmThreadId) void bb.sdk.threads.send({ threadId:input.pmThreadId, mode:"queue-if-active",
              input:[{ type:"text", mentions:[],
                text:`Lane Pilot: задача ${input.taskId} закрыта принятой без писателя — её проверки уже проходят на текущем main, main починила другая задача. Действий не нужно.` }] } as never).catch(() => undefined);
          }
        }
        if (!writerThreadId && !halfBound && last.status !== "accepted") {
          const reassigned = pendingReassign;
          // The writer's provider window is nearly spent (provider-usage): another model of the chain takes the task at once,
          // instead of a failed attempt that opens the breaker. Nothing is skipped when no other pair has room.
          const primaryPair = { providerId:typeof runSettings["writer.provider"] === "string" && runSettings["writer.provider"] ? runSettings["writer.provider"] as string : freshConfig.writerProviderId,
            model:typeof runSettings["writer.model"] === "string" && runSettings["writer.model"] ? runSettings["writer.model"] as string : freshConfig.writerModel };
          const spentWindow = await services.providerUsage.hold({ ...primaryPair, hostId:freshConfig.hostId, threshold:usageSkipPercent(runSettings), settings:runSettings });
          if (spentWindow && (await chainWithRoom(writerFallbackChain(primaryPair, writerFallbacks(runSettings), { providerId:freshConfig.pmProviderId, model:freshConfig.pmModel }), freshConfig.hostId, runSettings, input.taskId)).room) {
            const reason = usageHoldReason(primaryPair.providerId, primaryPair.model, spentWindow);
            transitionAttempt(db, attemptId, "blocked", { reason });
            last = { status:"blocked", reason, attemptId };
            primaryFailure = { status:"spawn_rejected", reason, attemptId };
            break;
          }
          // The task's overall budget of writers, kept across reloads and restarts (retry-budget.ts).
          // A reassigned task's new writer spends no attempt of the task's budget (the PM asked for it).
          const spent = reassigned ? null : await spendRetryBudget(bb.storage.kv as never, input.runId, input.taskId, "attempt");
          if (spent && !spent.ok) {
            const reason = retryBudgetReason(input.taskId, spent.record);
            transitionAttempt(db, attemptId, "blocked", { reason });
            last = { status:"blocked", reason, attemptId };
            break;
          }
          if (!reassigned) budget.noteAttempt();
          const afterAttempt=budget.check();
          if (!afterAttempt.ok) {
            const reason=budgetStopReason(afterAttempt.exceeded);
            transitionAttempt(db, attemptId, "blocked", { reason });
            last = { status:"blocked", reason, attemptId };
            break;
          }
          const carried=reassigned?.from?.thread_id&&reassigned.from.workspace_path&&!liveFolder ? {
            workspacePath:reassigned.from.workspace_path, environmentId:reassigned.from.environment_id, dirtBefore:reassigned.from.dirt_before,
            fromThreadId:reassigned.from.thread_id,
            brief:await collectHandoffBrief({ bb, host, hostId:input.config.hostId, threadId:reassigned.from.thread_id, workspacePath:reassigned.from.workspace_path,
              stopReason:`reassigned by the PM: ${reassigned.request.reason}` }),
          } : undefined;
          const requested=reassigned?.request.selection;
          pendingReassign=null;
          const spawned = await services.spawnWriterAttempt({
            projectId:input.projectId, runId:input.runId, taskId:input.taskId, attemptId,
            config:freshConfig, task:freshTask, plan:input.plan, pmThreadId:input.pmThreadId, pmReadContext, writerSettings:writerChoice,
            retryIndex:Math.max(0,countAttempts(db,input.runId,input.taskId)-1),
            // A fresh writer starts from main: of the failures before it, the task's own is the one to avoid, not a provider's cut.
            previousAttempt:previousAttemptBrief(last.status && isOwnFailure(last) ? last : own.failure ?? (last.status ? last : null), freshTask, undefined, liveFolder),
            ...(requested ? { emergency:{...requested, reason:"reassigned by the PM"} } : {}),
            ...(carried ? { continuation:carried } : {}),
          });
          if (!spawned.ok) {
            last = { status:spawned.status, reason:spawned.reason, attemptId:spawned.attemptId };
          } else {
            writerThreadId = spawned.threadId;
            if (liveFolder) { liveBackupId = attemptId; await bindLiveBackup(); }
            writerSelection=spawned.providerId&&spawned.model?{
              providerId:spawned.providerId,model:spawned.model,
              reasoningLevel:spawned.reasoningLevel,serviceTier:spawned.serviceTier,selectionSource:spawned.selectionSource,
            }:undefined;
            activeConfig = freshConfig;
            activeTask = retargetTask(freshTask,spawned.workspacePath);
            // In a folder without git every attempt of the task starts from the same state (the owned files are rolled
            // back), so a file outside owns_paths that an earlier attempt left behind keeps counting as changed until undone.
            dirtBefore = liveFolder && baselineDirtBefore ? baselineDirtBefore : spawned.dirtBefore;
            baselineDirtBefore ??=[...spawned.dirtBefore];
            baselineWorkspacePath ??=spawned.workspacePath;
            executionPacketSha256 = spawned.executionPacketSha256 ?? null;
          }
        }
        if (writerThreadId) {
          last = { ...await services.finishWriterAttempt({
            projectId:input.projectId, config:activeConfig, task:activeTask, runId:input.runId,
            taskId:input.taskId, attemptId, pmThreadId:input.pmThreadId, writerThreadId, dirtBefore,
          }), ...(executionPacketSha256 ? { executionPacketSha256 } : {}) };
          const workspaceBinding=getAttempt(db,attemptId);
          if(workspaceBinding?.workspace_path) last={...last,workspace:{path:workspaceBinding.workspace_path,
            environmentId:workspaceBinding.environment_id,decision:workspaceBinding.workspace_decision,
            ...(isLiveDecision(workspaceBinding.workspace_decision)?{mode:LIVE_FOLDER_RECEIPT}:{})}};
          // The question is already on the attempt. Drop the live-writer key before the awaits below (token
          // events, retry lookup, worktree remove): while it stayed until finally, the question sweep skipped
          // this task for the whole wait.
          if (failureClass(String(last.status), typeof last.reason === "string" ? last.reason : null) === "judgment") dropLiveWriterKey();
          await noteAttemptOutcome({ budget, writerThreadId, writerSelection, status:String(last.status), reason:typeof last.reason === "string" ? last.reason : null });
          noteOwnFailure(last);
        }
        if (last.status === "accepted") { acceptedAttemptId = attemptId; break; }
        // The PM moved the task to a fresh writer (lane_pilot_reassign_task): the stop is not a failure, so no attempt is spent.
        // The next iteration starts the writer in the stopped attempt's worktree, with its edits and a handoff brief.
        const reassign = last.status === "canceled" ? await takeReassignRequest(bb.storage.kv as never, attemptId) : null;
        if (reassign) {
          const stopped = getAttempt(db, attemptId);
          transitionAttempt(db, attemptId, "canceled", { threadId:stopped?.thread_id ?? undefined, reason:reassignedReason(reassign.reason) });
          pendingReassign={from:stopped, request:reassign};
          // A new session that is not charged: the loop top counts it back, so attemptsHere ends where it was.
          inSession=false;
          attemptsHere-=1;
          attemptId=id("lpattempt");
          createAttempt(db,{id:attemptId,runId:input.runId,taskId:input.taskId});
          writerThreadId=undefined;
          writerSelection=undefined;
          dirtBefore=[];
          executionPacketSha256=null;
          continue;
        }
        // A failure the writer can fix itself is redone in its own thread and worktree, with the reason.
        const failedBinding=getAttempt(db,attemptId);
        const moreAttempts = attemptsLeftAfter(failedBinding);
        let sessionEnd = moreAttempts ? sticky.sessionLimit(attemptId) : null;
        let redo = moreAttempts && !sessionEnd ? await sticky.retryWriter(attemptId, input.runId) : null;
        const turn = { failure:turnFailureKey(last), diff:typeof last.diffKey === "string" ? last.diffKey : null,
          streamError:isWriterStreamError(typeof last.reason === "string" ? last.reason : null) };
        if (redo && Date.now() - sessionStartedAt >= SESSION_MAX_MS) sessionEnd = `wall limit ${SESSION_MAX_MS / 60_000} min reached`;
        else if (redo && previousTurn && turn.diff && previousTurn.diff === turn.diff && previousTurn.failure === turn.failure) {
          sessionEnd = "no progress: the same failure and the same diff in two turns in a row";
        }
        if (sessionEnd) redo = null;
        // A provider cut is continued in its thread once. Cut again right away (ck-21 on 2026-10-12, «[unavailable]» twice
        // within 8 s), the provider is down: the writer chain below takes the task over in this worktree, with its edits,
        // instead of up to five empty turns or a «repeated_failure» block.
        if (redo && turn.streamError && previousTurn?.streamError) redo = null;
        const streamHandOff = turn.streamError && !redo;
        previousTurn = turn;
        // A failed attempt's own worktree is never merged; the next attempt starts from a fresh one.
        const removeFailedWorktree = () => removeWorktreeOf(failedBinding);
        // The worktree waits: the next attempt removes it when it starts, and a fallback writer may continue in it (below).
        if (!redo) { unremovedWorktree = failedBinding; await rollbackLive(); }
        if (last.status === "spawn_rejected" && typeof last.reason === "string"
          && (last.reason.startsWith("execution_packet_failed:") || last.reason.startsWith("attempt_worktree_")
            || last.reason.startsWith("attempt_workspace_"))) {
          const rejected = getAttempt(db, attemptId);
          if (rejected?.state === "spawn_rejected") transitionAttempt(db, attemptId, "blocked", { reason:last.reason });
          last = { ...last, status:"blocked" };
          break;
        }
        if (last.status !== "accepted" && last.status !== "blocked") primaryFailure={...last};
        const failed = String(last.status) as AttemptState;
        if (!RETRY_ELIGIBLE.includes(failed)) break;
        const attempt = getAttempt(db, attemptId);
        if (attempt?.state === "spawn_unknown" || attempt?.state === "spawn_requested") {
          writerThreadId = await services.reconcileAttemptThread(input.projectId, attempt).catch(() => "");
        } else if (attempt && !attempt.thread_id) {
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
          if ((scanned.kind === "blocked" && scanned.reason === "page_cap") || (scanned.kind === "error" && cursor.read() !== null)) break;
          if (scanned.kind === "blocked" || scanned.kind === "error") {
            // Both end the attempt: an error left it «spawn_rejected» with its stages closed, and nothing retried it (found by the
            // fault-injection simulation, tests/simulation). A reconcile_ reason is Lane Pilot's fault: the task is parked.
            transitionAttempt(db, attempt.id, "blocked", { reason:scanned.kind === "blocked" ? `reconcile_${scanned.reason}` : `reconcile_error: ${scanned.message}` });
            last = { ...last, status:"blocked", reason:scanned.kind === "blocked" ? scanned.reason : scanned.message };
            break;
          }
        }
        // A fault of Lane Pilot or the machine is not redone here: another writer meets the same fault. The task is
        // parked and restarts once a fix ships or the machine recovers.
        // A reason the rules have no confident match for goes to Jev (J-4, shadow by default: recorded, the rules' class used).
        const failedClass = await judgedFailureClass({ jev, settings:async () => runSettings, projectId:input.projectId, runId:input.runId },
          String(last.status), typeof last.reason === "string" ? last.reason : null, input.taskId);
        judged = { status: String(last.status), reason: typeof last.reason === "string" ? last.reason : null, klass: failedClass };
        // A check the host killed for time is not the task's red code: one retry, then it stops on its own budget.
        if (failedClass === "verification_timeout") {
          const reasons = (db.prepare("SELECT reason FROM lane_pilot_attempt WHERE run_id=? AND task_id=?").all(input.runId, input.taskId) as Array<{ reason: string | null }>).map((row) => row.reason);
          if (verificationTimeoutOverBudget(reasons)) {
            const reason = `verification_timeout_budget: the check timed out again after its ${VERIFICATION_TIMEOUT_RETRIES} retry; this budget is separate from the task's attempts. Raise timeout_sec or narrow the command, then dispatch again`;
            const latest = getAttempt(db, attemptId);
            if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason });
            last = { ...last, status:"blocked", reason };
            break;
          }
        }
        // A provider that takes no work fails every retry the same way: the writer chain below takes the task now.
        // The attempt ends blocked with its limit reason (uncharged); primaryFailure keeps the state the chain reads.
        // A writer that stayed silent through its nudges is handed on the same way: its session hung, not the task.
        if (failedClass === "limit" || isWriterSilent(typeof last.reason === "string" ? last.reason : null) || streamHandOff) {
          const latest = getAttempt(db, attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason:String(last.reason ?? last.status) });
          last = { ...last, status:"blocked" };
          break;
        }
        // A secret the checks need went away mid-task: the attempt is not charged and the task is parked until it is back.
        if (PARKED_CLASSES.has(failedClass) || isWaitingSecret(typeof last.reason === "string" ? last.reason : null)) {
          const latest = getAttempt(db, attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason:String(last.reason ?? last.status) });
          last = { ...last, status:"blocked" };
          break;
        }
        // The session ended: the turn cap or the wall cap blocks the task. A repeated red check (the same failure and
        // the same diff twice) does not: the next attempt goes to the next writer in the chain, not this one again.
        if (sessionEnd) {
          const ended = `${sessionEnd}: ${String(last.reason ?? last.status)}`;
          if (sessionEnd.startsWith("no progress:") && failedClass !== "verification_timeout" && /^verification failed\b/.test(String(last.reason ?? ""))) {
            checkEscalation = ended;
            break;
          }
          const latest = getAttempt(db, attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason:ended });
          last = { ...last, status:"blocked", reason:ended };
          break;
        }
        if (countChargedAttempts(db, input.runId, input.taskId) >= MAIN_ATTEMPT_LIMIT
          || attemptsHere >= MAIN_ATTEMPT_LIMIT + FREE_RETRY_LIMIT) {
          const latest = getAttempt(db, attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) {
            const exhausted = `retry limit 2 exhausted${typeof last.reason === "string" && last.reason ? `: ${last.reason}` : ""}`;
            transitionAttempt(db, latest.id, "blocked", { reason:exhausted });
            last = { ...last, status:"blocked", reason:exhausted };
          }
          break;
        }
        // Two attempts of the task family failing the same way stop the task: a third attempt of the same writer
        // would only repeat them. A repeated red check is the exception: the next attempt is the next writer in the
        // chain. A turn in the same thread is not stopped here: the session's own early stop is above.
        const repeated = redo ? null : repeatedFailureReason(familyFailure, { state:String(last.status), reason:typeof last.reason === "string" ? last.reason : null });
        if (repeated && failedClass !== "verification_timeout" && /^verification failed\b/.test(String(last.reason ?? ""))) {
          checkEscalation = repeated;
          primaryFailure = { ...last };
          break;
        }
        if (repeated) {
          const latest = getAttempt(db, attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason:repeated });
          last = { ...last, status:"blocked", reason:repeated };
          primaryFailure = { ...last };
          // The two normal moves are spent: the wall ladder opens (hunters from other sides, then the backlog), see src/rooms/wall.
          services.wall?.noteTaskStop({ projectId:input.projectId, runId:input.runId, taskId:input.taskId, family:taskFamily(input.taskId), state:familyFailure?.state ?? "validation_failed",
            reason:repeated.replace(/^repeated_failure:\s*/, ""), pmThreadId:input.pmThreadId ?? null, task:input.task, plan:input.plan })
            .catch((cause:unknown) => ctx.log(`wall: could not note the stop of ${input.taskId}: ${cause instanceof Error ? cause.message : String(cause)}`));
          break;
        }
        familyFailure = { state:String(last.status), reason:typeof last.reason === "string" ? last.reason : null };
        halfBound = false;
        const failedLast = last;
        if (unremovedWorktree) { const stale = unremovedWorktree; unremovedWorktree = undefined; await removeWorktreeOf(stale); }
        attemptId = id("lpattempt");
        createAttempt(db, { id:attemptId, runId:input.runId, taskId:input.taskId });
        writerThreadId = undefined;
        writerSelection=undefined;
        activeConfig = freshConfig;
        activeTask = freshTask;
        dirtBefore = [];
        executionPacketSha256 = null;
        if (redo && !await continueWith(redo, redo.kind, previousAttemptBrief({ ...failedLast, produced:[] }, freshTask, failedBinding?.dirt_before ?? [], liveFolder), failedBinding?.dirt_before)) {
          await removeFailedWorktree();
          await rollbackLive();
        }
        inSession = Boolean(redo && writerThreadId);
        if (inSession) await bindLiveBackup();
      }
      // No attempt was left for this start: end the queued attempt instead of leaving it queued with failed stages.
      if (attemptsHere === 0 && getAttempt(db, attemptId)?.state === "queued") {
        const exhausted = "retry limit 2 exhausted: the task's attempts were spent before this start";
        transitionAttempt(db, attemptId, "blocked", { reason:exhausted });
        last = { status:"blocked", reason:exhausted, attemptId };
      }
      if (last.status !== "accepted" && primaryFailure) {
        const loadedSettings=loadProjectSettings(db,input.projectId,getRunSettingsScopes(db,input.runId));
        const settings=writerOverlay ? { ...loadedSettings, ...writerOverlay } : rotatedWriterSettings(loadedSettings, input.taskId);
        const primaryProvider=typeof settings["writer.provider"] === "string" ? settings["writer.provider"] as string : input.config.writerProviderId;
        const primaryModel=typeof settings["writer.model"] === "string" && settings["writer.model"] ? settings["writer.model"] as string : input.config.writerModel;
        const pmSelection={providerId:input.config.pmProviderId,model:input.config.pmModel};
        // The writer's fallbacks in turn, then the PM's model; each takes over only while the failure is the model's, not the task's.
        // A provider, limit or catalog fault walks the chain. A repeated red check takes only the next writer (the same
        // pair is already excluded): another pass of this writer would only repeat the check.
        const primaryClass = failureClass(String(primaryFailure.status), typeof primaryFailure.reason === "string" ? primaryFailure.reason : null);
        const escalate = checkEscalation !== null && primaryClass === "task";
        const fullChain = primaryClass === "provider" || primaryClass === "limit" || escalate
          ? (await chainWithRoom(writerFallbackChain({providerId:primaryProvider,model:primaryModel},writerFallbacks(settings),pmSelection),input.config.hostId,settings,input.taskId)).chain
          : [];
        const chain = escalate ? fullChain.slice(0, 1) : fullChain;
        let failure:Record<string, unknown>=escalate ? { ...primaryFailure, checkEscalation:true } : primaryFailure;
        const primaryAttemptId=typeof primaryFailure.attemptId === "string" ? primaryFailure.attemptId : attemptId;
        // The writer the next fallback continues: the failed attempt that kept its worktree (worktree mode only), then each
        // fallback that started. Its thread and workspace are read when a fallback starts.
        let continueFrom:ReturnType<typeof getAttempt>=!liveFolder&&unremovedWorktree?.id===primaryAttemptId ? unremovedWorktree : undefined;
        /** The last fallback writer that ran: its failure is the task's result once the chain has ended. */
        let lastFallbackAttemptId:string|null=null;
        if (!chain.length) {
          if (escalate && checkEscalation) {
            const stuck = getAttempt(db, typeof primaryFailure.attemptId === "string" ? primaryFailure.attemptId : attemptId);
            if (stuck && RETRY_ELIGIBLE.includes(stuck.state as AttemptState)) transitionAttempt(db, stuck.id, "blocked", { reason:checkEscalation });
            last = { ...last, status:"blocked", reason:checkEscalation };
          }
          last={...last,emergencyFallback:{state:"skipped",
            reason:primaryClass === "provider" || primaryClass === "limit" ? "configured_pm_selection_matches_primary" : escalate ? "no next writer" : `failure is not a provider fault (${primaryClass})`}};
        }
        for (const fallback of chain) {
          const decision=emergencyFallbackDecision({
            state:String(failure.status ?? "unknown"),
            reason:typeof failure.reason === "string" ? failure.reason : null,
            stopConfirmed:failure.stopConfirmed === true,
            checkEscalation:failure.checkEscalation === true,
          });
          if (!decision.run) break;
          // A cancel stops the writer's thread, which reads as a provider failure; the chain must not take it as one
          // and start the next model (2026-10-04: an owner's stop of SelfyStudio was followed by a new fallback writer).
          if (typeof failure.attemptId === "string" && getAttempt(db, failure.attemptId)?.state === "canceled") break;
          if (getAttempt(db, attemptId)?.state === "canceled") break;
          // A file the contract expects and the writer did not make is the task's problem, not the model's limit:
          // another model meets the same contract (GLM spent 138 min per such task on 2026-10-03).
          if (typeof failure.reason === "string" && failure.reason.startsWith("missing expected_outputs")) break;
          const fallbackSpent = await spendRetryBudget(bb.storage.kv as never, input.runId, input.taskId, "fallback");
          if (!fallbackSpent.ok) {
            // The attempt that started the chain keeps the failure it ended with; the budget's reason goes to the log.
            ctx.log(`writer ${input.taskId}: ${retryBudgetReason(input.taskId, fallbackSpent.record)}`);
            break;
          }
          await rollbackLive();
          // The task moves to another writer: a retry BB's provider-retry queued in a failed thread must not wake it later.
          await releaseFailedThreads();
          const emergencySelection={providerId:fallback.providerId,model:fallback.model};
            // The interrupted writer's worktree goes on to the fallback with its edits, and the handoff tells the fallback what was done.
            const from=continueFrom;
            const continuation=from?.thread_id&&from.workspace_path ? {
              workspacePath:from.workspace_path, environmentId:from.environment_id, dirtBefore:from.dirt_before, fromThreadId:from.thread_id,
              brief:await collectHandoffBrief({ bb, host, hostId:input.config.hostId, threadId:from.thread_id, workspacePath:from.workspace_path,
                stopReason:`${String(failure.status ?? "failed")}${typeof failure.reason === "string" && failure.reason ? `: ${failure.reason}` : ""}` }),
            } : undefined;
            const emergencyAttemptId=id("lpattempt");
            createAttempt(db,{id:emergencyAttemptId,runId:input.runId,taskId:input.taskId});
            writerSelection=undefined;
            const spawned=await services.spawnWriterAttempt({
              projectId:input.projectId,runId:input.runId,taskId:input.taskId,attemptId:emergencyAttemptId,
              config:freshConfig,task:freshTask,plan:input.plan,pmThreadId:input.pmThreadId,pmReadContext,
              emergency:{...emergencySelection,reason:decision.reason,...(fallback.pm?{}:{reasoningLevel:fallback.reasoningLevel})},
              continuation,
              // The handoff names only the provider's stop; a stray file or a red check of an earlier turn would be redone
              // (vf-s4-items 2026-10-24: the fallback rewrote Buffs.luau, which the first turn had been rejected for).
              ...(own.failure ? { previousAttempt:previousAttemptBrief({ ...own.failure, produced:[] }, freshTask, undefined, liveFolder) } : {}),
            });
            if (!spawned.ok) {
              const fallbackFailureReason=`emergency_fallback_failed:${spawned.reason}`;
              transitionAttempt(db,emergencyAttemptId,"blocked",{reason:fallbackFailureReason});
              last={status:"blocked",reason:fallbackFailureReason,attemptId:emergencyAttemptId,
                emergencyFallback:{state:"failed",reason:spawned.reason,trigger:decision.reason,attemptId:emergencyAttemptId,providerId:fallback.providerId,model:fallback.model}};
              writerThreadId=undefined;
              lastFallbackAttemptId=null;
              // A fallback that cannot start (its own limit, not in this host's catalog) hands over to the next one.
              failure={status:"spawn_rejected",reason:spawned.reason};
              continue;
            } else {
              writerThreadId=spawned.threadId;
              // The fallback owns the continued worktree now; the next fallback, if this one fails, continues from here.
              if (continuation) unremovedWorktree=undefined;
              continueFrom=getAttempt(db,emergencyAttemptId);
              if (liveFolder) { liveBackupId=emergencyAttemptId; await bindLiveBackup(); }
              writerSelection=spawned.providerId&&spawned.model?{
              providerId:spawned.providerId,model:spawned.model,
              reasoningLevel:spawned.reasoningLevel,serviceTier:spawned.serviceTier,selectionSource:spawned.selectionSource,
            }:undefined;
              activeConfig=freshConfig;
              activeTask=retargetTask(freshTask,spawned.workspacePath);
              executionPacketSha256=spawned.executionPacketSha256 ?? null;
              const fallbackWorkspace=getAttempt(db,emergencyAttemptId)?.workspace_path;
              dirtBefore=!continuation&&baselineWorkspacePath&&fallbackWorkspace===baselineWorkspacePath
                ? baselineDirtBefore??spawned.dirtBefore : spawned.dirtBefore;
              const emergencyFallback={reason:decision.reason,primaryAttemptId,providerId:emergencySelection.providerId,model:emergencySelection.model};
              last={...await services.finishWriterAttempt({
                projectId:input.projectId,config:activeConfig,task:activeTask,runId:input.runId,taskId:input.taskId,
                attemptId:emergencyAttemptId,pmThreadId:input.pmThreadId,writerThreadId,dirtBefore,
                emergencyFallback,
              }),emergencyFallback:{state:"completed",...emergencyFallback,attemptId:emergencyAttemptId}};
              if (failureClass(String(last.status), typeof last.reason === "string" ? last.reason : null) === "judgment") dropLiveWriterKey();
              const workspaceBinding=getAttempt(db,emergencyAttemptId);
              if(workspaceBinding?.workspace_path) last={...last,workspace:{path:workspaceBinding.workspace_path,
                environmentId:workspaceBinding.environment_id,decision:workspaceBinding.workspace_decision,
                ...(isLiveDecision(workspaceBinding.workspace_decision)?{mode:LIVE_FOLDER_RECEIPT}:{})}};
              await noteAttemptOutcome({ budget, writerThreadId, writerSelection, status:String(last.status), reason:typeof last.reason === "string" ? last.reason : null });
              noteOwnFailure(last);
              if (last.status === "accepted") { acceptedAttemptId=emergencyAttemptId; break; }
              lastFallbackAttemptId=emergencyAttemptId;
              failure=last;
            }
        }
        // The chain ended without a writer that got through: the task ends blocked with the last fallback's reason, as
        // every exit of the loop above does. Left «validation_failed» it read as still at work: the PM was never told, and
        // a task that depends on it waited with no limit (SelfyStudio 2026-10-15, chat-free-muse-trial-api: 6.5 hours).
        const endedFallback=lastFallbackAttemptId && last.status !== "accepted" ? getAttempt(db,lastFallbackAttemptId) : undefined;
        if (endedFallback && RETRY_ELIGIBLE.includes(endedFallback.state as AttemptState)) {
          const endedReason=typeof last.reason === "string" && last.reason ? last.reason : String(last.status);
          transitionAttempt(db,endedFallback.id,"blocked",{reason:endedReason});
          last={...last,status:"blocked",reason:endedReason};
        }
      }
      // A worktree kept for a fallback that did not continue in it (no chain, a guard stopped it) is removed as any failed one.
      // A writer's question keeps its worktree: the answer continues there. Removing it here also hung the live-writer
      // key (the sweep then skipped the question) when the host call did not return.
      const asked = failureClass(String(last.status), typeof last.reason === "string" ? last.reason : null) === "judgment";
      const questionWorktree = asked && unremovedWorktree?.id === (typeof last.attemptId === "string" ? last.attemptId : attemptId);
      if (unremovedWorktree && !questionWorktree) await removeWorktreeOf(unremovedWorktree);
      // Whatever the writers left in a folder without git is taken back when no attempt was accepted.
      if (last.status !== "accepted") await rollbackLive();
      // The task is over for these writers (a writer's question keeps its thread: its answer goes on there).
      if (last.status !== "accepted" && failureClass(String(last.status), typeof last.reason === "string" ? last.reason : null) !== "judgment") await releaseFailedThreads();
      // The writer's turns on this task (its first answer and every feedback turn), kept in the stage receipt.
      const turns = writerThreadId ? countThreadTurns(db, input.runId, input.taskId, writerThreadId) : 0;
      if (turns) last = { ...last, turns };
      const accepted = last.status === "accepted";
      const reason = accepted ? undefined : String(last.reason ?? last.status ?? "writer_failed");
      // A writer's question would wait unseen: writers are quiet children and do not wake the PM.
      if (!accepted && reason && failureClass(String(last.status), reason) === "judgment" && input.pmThreadId) {
        noteToldPmDirectly(input.pmThreadId, input.taskId);
        void sendServiceMessage(bb, { threadId:input.pmThreadId, senderThreadId:writerThreadId || undefined,
          text:`Lane Pilot: ${input.taskId} stopped with a question from its writer. Answer it with lane_pilot_answer_writer (taskId, answer) — from the code or docs if they settle it, else ask the owner once; the writer continues in its own thread and no attempt is spent. ${WRITER_QUESTION_WAIT_TEXT} Send the task again only when the contract itself must change; tasks that depend on it wait for that.${liveFolder ? " This folder has no git, so the writer's files stay where they are and the folder stays locked: other tasks for it queue until this question is answered (or the task is sent again)." : ""}\n${reason.slice(0, 1200)}` }).catch(() => undefined);
      }
      if (!accepted && last.status !== "canceled") {
        void services.stability.onTaskFailed({ projectId:input.projectId, runId:input.runId, taskId:input.taskId,
          pmThreadId:input.pmThreadId, state:String(last.status), reason:reason ?? "",
          ...(judged && judged.status === String(last.status) && judged.reason === (typeof last.reason === "string" ? last.reason : null) ? { klass:judged.klass } : {}) }).catch(() => false);
      }
      for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
        const current = listStageReceipts(db, input.runId, input.taskId).find((row) => row.stageId === stageId);
        if (current?.state === "pending") {
          recordStage(db, { runId:input.runId, taskId:input.taskId, stageId, state:"running", input:input.plan });
        }
        const terminal = accepted ? "passed" : last.status === "canceled" ? "canceled" : "failed";
        recordStage(db, { runId:input.runId, taskId:input.taskId, stageId, state:terminal,
          input:input.plan, attempt:Math.min(countAttempts(db, input.runId, input.taskId),MAIN_ATTEMPT_LIMIT),
          providerId:stageId==="writer-agent"?writerSelection?.providerId:undefined,
          model:stageId==="writer-agent"?writerSelection?.model:undefined,threadId:writerThreadId,
          result:stageId === "writer-agent" ? {
            ...last,
            execution: writerSelection ? {
              providerId:writerSelection.providerId,
              model:writerSelection.model,
              reasoningLevel:writerSelection.reasoningLevel ?? null,
              serviceTier:writerSelection.serviceTier ?? null,
              selectionSource:writerSelection.selectionSource ?? null,
            } : last,
          } : accepted ? stageId === "verification"
            ? { produced:last.produced, verification:last.verification, runV2:last.runV2 }
            : last : null, reason:accepted ? undefined : reason });
      }
      refreshRun(input.runId);
      if (accepted && acceptedAttemptId) void sticky.noteAccepted(input.projectId, input.runId, input.task, acceptedAttemptId,
        Array.isArray(last.produced) ? (last.produced as unknown[]).filter((path):path is string => typeof path === "string") : [])
        .catch((cause) => ctx.log(`area record of ${input.taskId} failed: ${cause instanceof Error ? cause.message : String(cause)}`));
      if (accepted) services.startAfterAcceptance(input.projectId, input.runId, input.taskId, input.pmThreadId);
    })().catch((cause: unknown) => {
      // After a reload the database is closed: stop quietly, the next load reconciles the attempt.
      if (ctx.state.disposed) return;
      // A failed attempt's worktree that no fallback took is removed here too, as it was before fallbacks could keep it.
      if (unremovedWorktree) void removeWorktreeOf(unremovedWorktree).catch((removeCause) => bb.log.warn(`Lane Pilot could not remove the worktree of ${input.taskId}: ${removeCause instanceof Error ? removeCause.message : String(removeCause)}`));
      try {
        const message = cause instanceof Error ? cause.message : String(cause);
        const reason = `internal_error: ${message}`;
        bb.log.error(`Lane Pilot writer attempt ${attemptId} failed: ${message}`);
        // The writer may still be editing, so nothing is rolled back here; the originals wait in the backup.
        if (liveBackupId) bb.log.warn(`Lane Pilot: the owned files of ${input.taskId} are backed up in ~/.lane-pilot/live-backups/${liveBackupId} (folder without git, no rollback after an internal error)`);
        const attempt = getAttempt(db, attemptId);
        if(attempt?.state==="canceled"){
          markCanceledWriterStages(attempt,"writer attempt canceled before provider dispatch");
          refreshRun(input.runId);
          return;
        }
        if (attempt && ["queued", "spawn_requested", "spawn_unknown", "spawn_rejected", "running", "cancel_requested", "provider_error", "timeout", "empty_output", "validation_failed"].includes(attempt.state)) {
          transitionAttempt(db, attemptId, "blocked", { threadId:writerThreadId, reason });
        }
        void services.stability.onTaskFailed({ projectId:input.projectId, runId:input.runId, taskId:input.taskId,
          pmThreadId:input.pmThreadId, state:"blocked", reason }).catch(() => false);
        for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
          const current = listStageReceipts(db, input.runId, input.taskId).find((row) => row.stageId === stageId);
          if (!current || current.state === "passed" || current.state === "failed" || current.state === "skipped") continue;
          if (current.state === "pending") recordStage(db, { runId:input.runId, taskId:input.taskId, stageId, state:"running", input:input.plan });
          recordStage(db, { runId:input.runId, taskId:input.taskId, stageId,
            state:"failed", input:input.plan,
            attempt:Math.min(countAttempts(db, input.runId, input.taskId),MAIN_ATTEMPT_LIMIT),
            providerId:stageId==="writer-agent"?writerSelection?.providerId:undefined,
            model:stageId==="writer-agent"?writerSelection?.model:undefined,threadId:writerThreadId, reason });
        }
        try {
          refreshRun(input.runId);
        } catch (refreshCause) {
          bb.log.error(`Lane Pilot failed to refresh run ${input.runId} after attempt ${attemptId} error: ${refreshCause instanceof Error ? refreshCause.message : String(refreshCause)}`);
        }
      } catch (inner) {
        // A failure while recording the failure must never escape a detached task and crash BB.
        try { bb.log.error(`Lane Pilot writer attempt ${attemptId} could not record its failure: ${inner instanceof Error ? inner.message : String(inner)}`); } catch { /* ctx.state.disposed */ }
      }
    }).finally(() => {
      releaseWriterSlot?.();
      dropLiveWriterKey();
    });
  }

  return { startWriterTask };
}

/** Two tasks of the same page or feature, by their contract's `area`. */
export function sameArea(a:string | undefined, b:string | undefined):boolean {
  return Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());
}

/** Whether `dependsOn` names `taskId`, either exactly or by its base id («P1» names a redispatched «P1.2»). */
export function dependsOnTask(dependsOn:readonly string[] | undefined, taskId:string):boolean {
  return (dependsOn ?? []).some((dep) => dep === taskId || (taskId.startsWith(`${dep}.`) && /^\d+$/.test(taskId.slice(dep.length + 1))));
}

