import { retryBudgetReason, spendRetryBudget } from "../../retry-budget";
import { breakerKey, budgetStopReason, classifyFailure, runningWriterBudgetStop, tokenUsageFromEvent, type RunBudget } from "@lane-pilot/resilience";
import type { DirtSnapshot } from "../../cli-outcome";
import type { PrototypeConfig, TaskV2 } from "../../contracts";
import { countAttempts, countChargedAttempts, countThreadTurns, createAttempt, getAttempt, getReasoningTrace, getRun, getRunSettingsScopes, getTask, getTaskPlan, latestTaskAttemptState, listOpenAttempts, listStageReceipts, loadProjectSettings, transitionAttempt } from "../../database";
import { taskV2Schema } from "../../contracts";
import { ownsPathsOverlap } from "../../owns-paths";
import { reconcile } from "../../reconcile";
import { emergencyFallbackDecision } from "../../stages/emergency-writer";
import { writerFallbackChain, writerFallbacks } from "../../writer-fallbacks";
import { MAIN_ATTEMPT_LIMIT, RETRY_ELIGIBLE } from "../../state-machine";
import { FREE_RETRY_LIMIT, PARKED_CLASSES, SESSION_MAX_MS, isWriterSilent, repeatedFailureReason, taskFamily, turnFailureKey } from "../../failure-class";
import { isTaskSatisfied } from "../blocked-by";
import { previousAttemptBrief, stickyTurnPrompt } from "../writer-task";
import { isMainfixTask } from "../../validate-output";
import { openDatabase } from "../../database";
import { createWriterSticky } from "./sticky";
import { failureClass } from "../../failure-class";

/** How long a task waits for a blocked dependency to be sent again and accepted. */
const DEPENDENCY_REDO_WAIT_MS = 6 * 3600_000;
import type { AttemptState } from "../../state-machine";
import { closeWriterStages, recordStage } from "../stage-records";
import { id, stringAt } from "../values";
import { shouldMergeAttemptWorktree } from "./spawn";
import { isLiveDecision, LIVE_FOLDER_RECEIPT } from "../../live-folder";
import { resolve } from "node:path";
import { findThreadsByMetadata } from "../thread-keys";
import type { ServerCore } from "../core";
import type { Services } from "../services";

/** Where a new attempt of the task starts: the run's workspace, whatever worktree a resumed attempt was bound to. */
export function freshAttemptStart(task:TaskV2, config:PrototypeConfig, runWorkspace:string|null):{task:TaskV2;config:PrototypeConfig} {
  if (!runWorkspace || resolve(task.project_cwd) === resolve(runWorkspace)) return { task, config };
  return {
    task:{...task,project_cwd:runWorkspace,verification:task.verification.map((command)=>({...command,cwd:runWorkspace}))},
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

export function createWriterStart(ctx: ServerCore, services: Services) {
  const { bb, db, effectiveProjectSettings, host, markCanceledWriterStages, refreshRun, runPolicyFor } = ctx;
  const sticky = createWriterSticky(ctx, services);

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

  function startWriterTask(input:{
    projectId:string; runId:string; taskId:string; firstAttemptId:string; pmThreadId:string;
    config:PrototypeConfig; task:TaskV2; plan:string; writerThreadId?:string; dirtBefore?:DirtSnapshot[]; pmReadContext?:string;
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
    let { task:freshTask, config:freshConfig } = freshAttemptStart(input.task, input.config, getRun(db, input.runId)?.writer_workspace_path ?? null);
    let activeConfig = input.config;
    let activeTask = input.task;
    let dirtBefore = input.dirtBefore ?? [];
    let baselineDirtBefore:DirtSnapshot[]|null=input.dirtBefore?[...input.dirtBefore]:null;
    let baselineWorkspacePath:string|null=input.dirtBefore?input.task.project_cwd:null;
    let executionPacketSha256:string|null = null;
    let last: Record<string, unknown> = {};
    let primaryFailure:Record<string,unknown>|null=null;
    // An earlier task of the same family (a redispatch, a mainfix) that failed the same way stops the next one early.
    let familyFailure = familyFailureRecord(db, input.runId, input.taskId);
    let acceptedAttemptId:string|null=null;
    const pmReadContext=input.pmReadContext ?? stringAt(listStageReceipts(db,input.runId,input.taskId).find((row)=>row.stageId==="pm-read")?.result,"summary") ?? "";
    let releaseWriterSlot:(()=>void)|undefined;
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
      const folder = getRun(db,input.runId)?.writer_workspace_path ?? input.task.project_cwd;
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
      const deps = [...new Set((input.task.depends_on ?? []).filter((dep) => dep && dep !== input.taskId))];
      let noted = "";
      const since = Date.now();
      const blockedSince = new Map<string, number>();
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
          if (state === "canceled") return `depends_on ${dep}: that task ended canceled`;
          if (state === "blocked") {
            // The PM verified this blocked task by hand (lane_pilot_update_task satisfied:true): its dependents go on.
            if (await isTaskSatisfied(bb.storage.kv as never, input.projectId, dep)) continue;
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
              reason:redo.length ? `waiting for depends_on: ${pending.join(",")} (${redo.join(", ")} ended blocked; starts once it is sent again and accepted)` : `waiting for depends_on: ${pending.join(",")}` });
          }
        }
        await new Promise((wake) => setTimeout(wake, 10_000));
      }
    };
    const waitForOverlappingTasks = async (shouldStop?:()=>string|null) => {
      const base = getRun(db,input.runId)?.writer_workspace_path;
      let noted = "";
      for (;;) {
        if (ctx.isDisposed()) return;
        const stop = shouldStop?.();
        if (stop) return stop;
        const open = listOpenAttempts(db);
        const mine = open.findIndex((row) => row.id === attemptId);
        if (mine < 0) return;
        const blocker = open.slice(0, mine).find((row) => {
          if (row.task_id === input.taskId || row.project_id !== input.projectId) return false;
          if (base && getRun(db,row.run_id)?.writer_workspace_path !== base) return false;
          const parsed = taskV2Schema.safeParse(getTask(db,row.task_id)?.contract);
          // A task that depends on this one waits for it anyway; waiting for it back is a deadlock
          // (live 2026-10-03: price-watermark.5 depends_on how.5, how.5 queued behind price-watermark.5).
          if (parsed.success && dependsOnTask(parsed.data.depends_on, input.taskId)) return false;
          // A queued task still waiting for its own depends_on works on nothing yet, so it holds no one: through a
          // chain (A waits on B's area, B depends on C, C on A) it was a deadlock of a whole run (BB-сервис 2026-10-05).
          if (row.state === "queued" && parsed.success && (parsed.data.depends_on ?? [])
            .some((dep) => dep !== row.task_id && latestTaskAttemptState(db, row.project_id, dep) !== "accepted")) return false;
          // One writer at a time per area: the next task of a page continues in its writer's thread once it is free.
          if (liveFolder) return true;
          if (parsed.success && sameArea(parsed.data.area, input.task.area)) return true;
          return parsed.success && ownsPathsOverlap(parsed.data.owns_paths, input.task.owns_paths);
        });
        if (!blocker) return;
        if (noted !== blocker.id) {
          noted = blocker.id;
          ctx.log(`writer ${input.taskId} waits for ${blocker.task_id}: ${liveFolder ? "one writer at a time in a folder without git" : "their owns_paths overlap"}`);
          const stage = listStageReceipts(db,input.runId,input.taskId).find((row) => row.stageId === "writer-agent");
          if (!stage || stage.state === "pending") {
            recordStage(db, { runId:input.runId, taskId:input.taskId, stageId:"writer-agent", state:"pending", input:input.plan,
              reason:`waiting for ${blocker.task_id} (thread ${blocker.thread_id ?? "not started"}): ${liveFolder ? "one writer at a time in a folder without git" : `${input.task.area ? "same area or " : ""}owns_paths overlap`}` });
          }
        }
        await new Promise((wake) => setTimeout(wake, 10_000));
      }
    };
    void (async () => {
      const policy=runPolicyFor(input.runId);
      const runSettings=(await effectiveProjectSettings(input.projectId,getRunSettingsScopes(db,input.runId))).values;
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
      const runFolder = getRun(db,input.runId)?.writer_workspace_path ?? input.task.project_cwd;
      liveFolder = await services.isLiveFolder(input.runId, input.config.hostId, runFolder);
      // An attempt resumed on its writer's thread (the PM's answer, a reload) goes on under the backup it began with.
      if (liveFolder && writerThreadId) {
        const saved = await bb.storage.kv.get(liveBackupKey(attemptId)).catch(() => null);
        if (typeof saved === "string") liveBackupId = saved;
      }
      const dependency = await waitForDependencies(wallOrTokenStop);
      if (dependency) {
        blockBeforeWriter(dependency);
        return;
      }
      const overlapStop = await waitForOverlappingTasks(wallOrTokenStop);
      if (overlapStop) {
        blockBeforeWriter(overlapStop);
        return;
      }
      // Several tasks failed on the same Lane Pilot fault just now, or the disk is nearly full: starting more only burns them too.
      for (let noted = ""; ;) {
        if (ctx.isDisposed()) return;
        const budgetStop = wallOrTokenStop();
        if (budgetStop) { blockBeforeWriter(budgetStop); return; }
        const base = getRun(db, input.runId)?.writer_workspace_path;
        const held = services.stability.breakerHolds(input.projectId)
          ?? (base ? await services.stability.diskHolds(input.config.hostId, base) : null);
        if (!held) break;
        if (noted !== held) {
          noted = held;
          ctx.log(`writer ${input.taskId} waits: ${held}`);
          recordStage(db, { runId:input.runId, taskId:input.taskId, stageId:"writer-agent", state:"pending", input:input.plan,
            reason:`waiting: ${held}; starts by itself once it clears` });
        }
        await new Promise((wake) => setTimeout(wake, 30_000));
      }
      releaseWriterSlot=liveFolder
        ? await services.runWriterPool.acquire(`live-folder:${input.config.hostId}:${resolve(runFolder)}`,1)
        : await services.runWriterPool.acquire(input.runId,policy.pools.provider);
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
        ({ task:freshTask, config:freshConfig } = freshAttemptStart(input.task, input.config, getRun(db, input.runId)?.writer_workspace_path ?? null));
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
      let previousTurn:{ failure:string; diff:string|null } | null = null;
      /** Another attempt follows this failure: the same conditions the loop checks below before it creates one. */
      const attemptsLeftAfter = (binding:ReturnType<typeof getAttempt>) => Boolean(binding?.thread_id)
        && RETRY_ELIGIBLE.includes(String(last.status) as AttemptState)
        && countChargedAttempts(db, input.runId, input.taskId) < MAIN_ATTEMPT_LIMIT
        && attemptsHere + 1 < MAIN_ATTEMPT_LIMIT + FREE_RETRY_LIMIT;
      /** Takes over an existing writer thread for this attempt; false leaves the attempt to a fresh spawn. */
      const continueWith = async (writer:NonNullable<Awaited<ReturnType<typeof sticky.hotWriter>>>, kind:"next-task"|"retry"|"merge", previousAttempt:string, keepDirt?:DirtSnapshot[]):Promise<boolean> => {
        const bound = {...freshTask,project_cwd:writer.workspacePath,verification:freshTask.verification.map(command=>({...command,cwd:writer.workspacePath}))};
        const turn = await sticky.continueInThread({ runId:input.runId, taskId:input.taskId, attemptId, config:freshConfig, writer, kind, dirtBefore:keepDirt,
          prompt:(conflicts) => stickyTurnPrompt({ kind, task:bound, previousAttempt:kind === "merge" ? "" : previousAttempt, conflicts, liveFolder }) });
        if (!turn.ok) {
          ctx.log(`writer ${input.taskId}: ${kind} in thread ${writer.threadId} not possible (${turn.reason}); a fresh writer starts`);
          // A half-bound attempt cannot take a fresh spawn: it ends as Lane Pilot's fault and the retry spawns.
          if (turn.bound) {
            transitionAttempt(db, attemptId, "spawn_rejected", { reason:turn.reason });
            last = { status:"spawn_rejected", reason:turn.reason, attemptId };
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
      // The area's writer from an earlier task of this run takes this one in its own thread.
      if (!writerThreadId && input.task.area && !liveFolder) {
        const hot = await sticky.hotWriter(input.projectId, input.runId, input.task.area);
        if (hot) await continueWith(hot, "next-task", "");
      }
      while (attemptsLeft()) {
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
          // The task's overall budget of writers, kept across reloads and restarts (retry-budget.ts).
          const spent = await spendRetryBudget(bb.storage.kv as never, input.runId, input.taskId, "attempt");
          if (!spent.ok) {
            const reason = retryBudgetReason(input.taskId, spent.record);
            transitionAttempt(db, attemptId, "blocked", { reason });
            last = { status:"blocked", reason, attemptId };
            break;
          }
          budget.noteAttempt();
          const afterAttempt=budget.check();
          if (!afterAttempt.ok) {
            const reason=budgetStopReason(afterAttempt.exceeded);
            transitionAttempt(db, attemptId, "blocked", { reason });
            last = { status:"blocked", reason, attemptId };
            break;
          }
          const spawned = await services.spawnWriterAttempt({
            projectId:input.projectId, runId:input.runId, taskId:input.taskId, attemptId,
            config:freshConfig, task:freshTask, plan:input.plan, pmThreadId:input.pmThreadId, pmReadContext,
            retryIndex:Math.max(0,countAttempts(db,input.runId,input.taskId)-1),
            previousAttempt:previousAttemptBrief(last.status ? last : null, freshTask, undefined, liveFolder),
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
            activeTask = {...freshTask,project_cwd:spawned.workspacePath,
              verification:freshTask.verification.map(command=>({...command,cwd:spawned.workspacePath}))};
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
          await noteAttemptOutcome({ budget, writerThreadId, writerSelection, status:String(last.status), reason:typeof last.reason === "string" ? last.reason : null });
        }
        if (last.status === "accepted") { acceptedAttemptId = attemptId; break; }
        // A failure the writer can fix itself is redone in its own thread and worktree, with the reason.
        const failedBinding=getAttempt(db,attemptId);
        const moreAttempts = attemptsLeftAfter(failedBinding);
        let sessionEnd = moreAttempts ? sticky.sessionLimit(attemptId) : null;
        let redo = moreAttempts && !sessionEnd ? await sticky.retryWriter(attemptId, input.runId) : null;
        const turn = { failure:turnFailureKey(last), diff:typeof last.diffKey === "string" ? last.diffKey : null };
        if (redo && Date.now() - sessionStartedAt >= SESSION_MAX_MS) sessionEnd = `wall limit ${SESSION_MAX_MS / 60_000} min reached`;
        else if (redo && previousTurn && turn.diff && previousTurn.diff === turn.diff && previousTurn.failure === turn.failure) {
          sessionEnd = "no progress: the same failure and the same diff in two turns in a row";
        }
        if (sessionEnd) redo = null;
        previousTurn = turn;
        // A failed attempt's own worktree is never merged; the next attempt starts from a fresh one.
        const removeFailedWorktree = async () => {
          const failedBase=getRun(db,input.runId)?.writer_workspace_path;
          if(failedBinding?.workspace_path&&failedBinding.environment_id===null&&failedBase&&shouldMergeAttemptWorktree(failedBinding.workspace_path,failedBase)) {
            await host.call("gitRemoveWorktree",{requestedHostId:input.config.hostId,basePath:failedBase,worktreePath:failedBinding.workspace_path},
              {hostId:input.config.hostId,timeoutMs:60_000}).catch((cause)=>bb.log.warn(`Lane Pilot could not remove worktree of ${failedBinding.id}: ${cause instanceof Error?cause.message:String(cause)}`));
          }
        };
        if (!redo) { await removeFailedWorktree(); await rollbackLive(); }
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
          const scanned = await reconcile({
            list: async ({ limit, offset }) => (await bb.sdk.threads.list({
              projectId:input.projectId, originPluginId:"lane-pilot", includeHidden:true, archived:false, limit, offset,
            })).map((thread) => ({ id:thread.id })),
            metadata: async (threadId) => bb.sdk.threads.getPluginMetadata({ threadId }),
            find: (match) => findThreadsByMetadata(bb, match, input.projectId),
          }, { lanePilotRunId:attempt.run_id, lanePilotTaskId:attempt.task_id, attemptId:attempt.id });
          if (scanned.kind === "blocked" || scanned.kind === "error") {
            if (scanned.kind === "blocked") transitionAttempt(db, attempt.id, "blocked", { reason:`reconcile_${scanned.reason}` });
            last = { ...last, status:"blocked", reason:scanned.kind === "blocked" ? scanned.reason : scanned.message };
            break;
          }
        }
        // A fault of Lane Pilot or the machine is not redone here: another writer meets the same fault. The task is
        // parked and restarts once a fix ships or the machine recovers.
        const failedClass = failureClass(String(last.status), typeof last.reason === "string" ? last.reason : null);
        // A provider that takes no work fails every retry the same way: the writer chain below takes the task now.
        // The attempt ends blocked with its limit reason (uncharged); primaryFailure keeps the state the chain reads.
        // A writer that stayed silent through its nudges is handed on the same way: its session hung, not the task.
        if (failedClass === "limit" || isWriterSilent(typeof last.reason === "string" ? last.reason : null)) {
          const latest = getAttempt(db, attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason:String(last.reason ?? last.status) });
          last = { ...last, status:"blocked" };
          break;
        }
        if (PARKED_CLASSES.has(failedClass)) {
          const latest = getAttempt(db, attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason:String(last.reason ?? last.status) });
          last = { ...last, status:"blocked" };
          break;
        }
        // The session ended: the turn cap, the wall cap or no progress. The task is blocked with its last reason; another
        // writer meets the same task, so none is started.
        if (sessionEnd) {
          const latest = getAttempt(db, attemptId);
          const ended = `${sessionEnd}: ${String(last.reason ?? last.status)}`;
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
        // Two attempts of the task family failing the same way stop the task: a third attempt and a fallback writer
        // would only repeat them. The blocked reason names it for the PM.
        // A turn in the same thread is not stopped by it: the session's own early stop (same failure, same diff) is above.
        const repeated = redo ? null : repeatedFailureReason(familyFailure, { state:String(last.status), reason:typeof last.reason === "string" ? last.reason : null });
        if (repeated) {
          const latest = getAttempt(db, attemptId);
          if (latest && RETRY_ELIGIBLE.includes(latest.state as AttemptState)) transitionAttempt(db, latest.id, "blocked", { reason:repeated });
          last = { ...last, status:"blocked", reason:repeated };
          primaryFailure = { ...last };
          break;
        }
        familyFailure = { state:String(last.status), reason:typeof last.reason === "string" ? last.reason : null };
        halfBound = false;
        const failedLast = last;
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
        const settings=loadProjectSettings(db,input.projectId,getRunSettingsScopes(db,input.runId));
        const primaryProvider=typeof settings["writer.provider"] === "string" ? settings["writer.provider"] as string : input.config.writerProviderId;
        const primaryModel=typeof settings["writer.model"] === "string" && settings["writer.model"] ? settings["writer.model"] as string : input.config.writerModel;
        const pmSelection={providerId:input.config.pmProviderId,model:input.config.pmModel};
        // The writer's fallbacks in turn, then the PM's model; each takes over only while the failure is the model's, not the task's.
        // Only a provider, limit or catalog fault moves down the writer chain: a task's own failure (an answered
        // empty_output, a repeated failure) gets no fallback writer — another model meets the same task.
        const primaryClass = failureClass(String(primaryFailure.status), typeof primaryFailure.reason === "string" ? primaryFailure.reason : null);
        const chain = primaryClass === "provider" || primaryClass === "limit"
          ? writerFallbackChain({providerId:primaryProvider,model:primaryModel},writerFallbacks(settings),pmSelection)
          : [];
        let failure:Record<string, unknown>=primaryFailure;
        const primaryAttemptId=typeof primaryFailure.attemptId === "string" ? primaryFailure.attemptId : attemptId;
        if (!chain.length) last={...last,emergencyFallback:{state:"skipped",
          reason:primaryClass === "provider" || primaryClass === "limit" ? "configured_pm_selection_matches_primary" : `failure is not a provider fault (${primaryClass})`}};
        for (const fallback of chain) {
          const decision=emergencyFallbackDecision({
            state:String(failure.status ?? "unknown"),
            reason:typeof failure.reason === "string" ? failure.reason : null,
            stopConfirmed:failure.stopConfirmed === true,
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
          const emergencySelection={providerId:fallback.providerId,model:fallback.model};
            const emergencyAttemptId=id("lpattempt");
            createAttempt(db,{id:emergencyAttemptId,runId:input.runId,taskId:input.taskId});
            writerSelection=undefined;
            const spawned=await services.spawnWriterAttempt({
              projectId:input.projectId,runId:input.runId,taskId:input.taskId,attemptId:emergencyAttemptId,
              config:freshConfig,task:freshTask,plan:input.plan,pmThreadId:input.pmThreadId,pmReadContext,
              emergency:{...emergencySelection,reason:decision.reason,...(fallback.pm?{}:{reasoningLevel:fallback.reasoningLevel})},
            });
            if (!spawned.ok) {
              const fallbackFailureReason=`emergency_fallback_failed:${spawned.reason}`;
              transitionAttempt(db,emergencyAttemptId,"blocked",{reason:fallbackFailureReason});
              last={status:"blocked",reason:fallbackFailureReason,attemptId:emergencyAttemptId,
                emergencyFallback:{state:"failed",reason:spawned.reason,trigger:decision.reason,attemptId:emergencyAttemptId,providerId:fallback.providerId,model:fallback.model}};
              writerThreadId=undefined;
              // A fallback that cannot start (its own limit, not in this host's catalog) hands over to the next one.
              failure={status:"spawn_rejected",reason:spawned.reason};
              continue;
            } else {
              writerThreadId=spawned.threadId;
              if (liveFolder) { liveBackupId=emergencyAttemptId; await bindLiveBackup(); }
              writerSelection=spawned.providerId&&spawned.model?{
              providerId:spawned.providerId,model:spawned.model,
              reasoningLevel:spawned.reasoningLevel,serviceTier:spawned.serviceTier,selectionSource:spawned.selectionSource,
            }:undefined;
              activeConfig=freshConfig;
              activeTask={...freshTask,project_cwd:spawned.workspacePath,
                verification:freshTask.verification.map(command=>({...command,cwd:spawned.workspacePath}))};
              executionPacketSha256=spawned.executionPacketSha256 ?? null;
              const fallbackWorkspace=getAttempt(db,emergencyAttemptId)?.workspace_path;
              dirtBefore=baselineWorkspacePath&&fallbackWorkspace===baselineWorkspacePath
                ? baselineDirtBefore??spawned.dirtBefore : spawned.dirtBefore;
              const emergencyFallback={reason:decision.reason,primaryAttemptId,providerId:emergencySelection.providerId,model:emergencySelection.model};
              last={...await services.finishWriterAttempt({
                projectId:input.projectId,config:activeConfig,task:activeTask,runId:input.runId,taskId:input.taskId,
                attemptId:emergencyAttemptId,pmThreadId:input.pmThreadId,writerThreadId,dirtBefore,
                emergencyFallback,
              }),emergencyFallback:{state:"completed",...emergencyFallback,attemptId:emergencyAttemptId}};
              const workspaceBinding=getAttempt(db,emergencyAttemptId);
              if(workspaceBinding?.workspace_path) last={...last,workspace:{path:workspaceBinding.workspace_path,
                environmentId:workspaceBinding.environment_id,decision:workspaceBinding.workspace_decision,
                ...(isLiveDecision(workspaceBinding.workspace_decision)?{mode:LIVE_FOLDER_RECEIPT}:{})}};
              await noteAttemptOutcome({ budget, writerThreadId, writerSelection, status:String(last.status), reason:typeof last.reason === "string" ? last.reason : null });
              if (last.status === "accepted") { acceptedAttemptId=emergencyAttemptId; break; }
              failure=last;
            }
        }
      }
      // Whatever the writers left in a folder without git is taken back when no attempt was accepted.
      if (last.status !== "accepted") await rollbackLive();
      // The writer's turns on this task (its first answer and every feedback turn), kept in the stage receipt.
      const turns = writerThreadId ? countThreadTurns(db, input.runId, input.taskId, writerThreadId) : 0;
      if (turns) last = { ...last, turns };
      const accepted = last.status === "accepted";
      const reason = accepted ? undefined : String(last.reason ?? last.status ?? "writer_failed");
      // A writer's question would wait unseen: writers are quiet children and do not wake the PM.
      if (!accepted && reason && failureClass(String(last.status), reason) === "judgment" && input.pmThreadId) {
        void bb.sdk.threads.send({ threadId:input.pmThreadId, mode:"queue-if-active", input:[{ type:"text", mentions:[],
          text:`Lane Pilot: ${input.taskId} stopped with a question from its writer. Answer it with lane_pilot_answer_writer (taskId, answer) — from the code or docs if they settle it, else ask the owner once; the writer continues in its own thread and no attempt is spent. Send the task again only when the contract itself must change; tasks that depend on it wait for that.\n${reason.slice(0, 1200)}` }] } as never).catch(() => undefined);
      }
      if (!accepted && last.status !== "canceled") {
        void services.stability.onTaskFailed({ projectId:input.projectId, runId:input.runId, taskId:input.taskId,
          pmThreadId:input.pmThreadId, state:String(last.status), reason:reason ?? "" }).catch(() => false);
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
      if (accepted) services.maintainMemoryAfterAcceptance(input.projectId, input.runId, input.taskId, input.pmThreadId);
      if (accepted) services.maintainProjectLifeAfterAcceptance(input.projectId, input.runId, input.taskId, input.pmThreadId);
    })().catch((cause: unknown) => {
      // After a reload the database is closed: stop quietly, the next load reconciles the attempt.
      if (ctx.state.disposed) return;
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
        if (attempt && ["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested", "provider_error", "timeout", "empty_output", "validation_failed"].includes(attempt.state)) {
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
      services.activeWriterTasks.delete(key);
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

