import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { runOnHost } from "@lane-pilot/host-calls";
import { id, isNotFound, orMiss } from "@lane-pilot/kit";
import { failureClass } from "../../../contracts";
import { QUALITY_MODE_SETTING, resolveQualityMode } from "../../../contracts/quality-mode";
import type { ServerCore } from "../../../contracts/server";
import { runPlanCritique, runPmRead, runSpecialistReview } from "../../../critique/server";
import { overdueDeferrals } from "../../../deferral/server";
import { closeWriterStages, recordStage } from "../../../runs/server";
import { TASK_HOME_EXCLUDE, contractEditions, countAttempts, createAttempt, getAttempt, getRunSettingsScopes, getTaskGitBase, hasTaskHome, listStageReceipts, loadProjectSettings, saveTaskGitBase, setRunState, transitionAttempt, writeReplacing } from "../../../storage";
import { isMainfixTask } from "../../../tasks";
import { withUsage } from "../../../usage/server";
import { appendExcludeCommand, filecardsFileText, persistTaskFolder } from "../../../worktree";
import type { NodeExecutor, StepContext, WorkflowEngine } from "../../../workflow";
import { provideLpTaskPipeline } from "../../../workflow/server";
import { pmReadBrief } from "../../models/writer-brief";
import { createDispatchRuntimeResolver, registerAttemptGraphExecutors } from "./attempt-graph";
import { blockedReply, skipOpenStage, skipWriterStages, type DispatchRuntime, type DispatchServices } from "../services/dispatch-runtime";
import { pollAttempt, registerWriterFallbackExecutors } from "./dispatch-workflow-fallback";
import { reopenWriterStages, TERMINAL_ATTEMPT } from "../services/dispatch-runtime";
import { registerExecutionPacketGate } from "./execution-packet-gate";
import { PM_STOPPED_PLANNER_LOOP, planReviseConfig, runPlanRevise } from "../services/plan-revise";
import { noteStageTaskHomeReads, recordPlanCritique, recordPlannerRevision, recordTaskHomeFile, stagePlanText } from "../services/task-home";
import { taskFileCards } from "../services/writer-knowledge";
import { engineServices, endedReply, handoffOf, need, plannerLoopState, roundsOf, stepRef, text } from "../services/dispatch-workflow-ops";
export { buildQueuedReply, dispatchReply, endedAttemptReply, type DispatchRuntime } from "../services/dispatch-runtime";
export { startDispatchRun, rerunDispatchStages } from "../services/dispatch-workflow-ops";

export function registerDispatchExecutors(engine: WorkflowEngine, bb?: BbPluginApi, defaultServices?: { ctx?: ServerCore; services: DispatchServices }): void {
  if (defaultServices) engineServices.set(engine, defaultServices);
  /**
   * `stage`: the stage whose helper thread this step runs. Once the stage function returns, the thread its receipt names is read for what it spent
   * and the engine adds that to the run (`lane_pilot_wf_run.tokens_used`), so a budget sees the cost. A receipt the stage did not write now (an
   * earlier run's, found again) is not charged a second time.
   */
  const exec = (key: string, run: (r: DispatchRuntime, ctx: StepContext<DispatchRuntime>) => Promise<Record<string, unknown>>, extra: Partial<NodeExecutor<DispatchRuntime>> = {}, stage?: "pm-read" | "plan-critique" | "specialist-review") =>
    engine.register<DispatchRuntime>(key, { run: async (ctx) => {
      const r = need(ctx);
      const since = Date.now();
      const output = await run(r, ctx);
      const receipt = stage ? listStageReceipts(r.ctx.db, r.runId, r.taskId).find((row) => row.stageId === stage) : undefined;
      return { output, ...(receipt?.threadId && receipt.updatedAt >= since ? await withUsage(r.ctx.bb, receipt.threadId) : {}) };
    }, ...extra });

  exec("lp.pm-read", async (r, ctx) => {
    // The plan comes from the task home's PLAN.md by the manifest (docs/task-folder.md), not from what the dispatch held in memory.
    const plan = await stagePlanText(r.ctx, r.taskId, "pm-read", r.plan);
    await noteStageTaskHomeReads(r.ctx, r.taskId, "pm-read", ["contract"]).catch(() => undefined);
    const packetSha256 = text(ctx.input.with.packetSha256);
    const selected = ctx.input.with.selectedLines;
    const pmRead = await runPmRead({ stageHelperSettings: r.services.stageHelperSettings, bb: r.ctx.bb, db: r.ctx.db, projectId: r.projectId, runId: r.runId, taskId: r.taskId, pmThreadId: r.threadId, config: r.runConfig, task: r.task, plan, workflow: stepRef(ctx),
      ...(packetSha256 ? { packetSha256 } : {}), ...(typeof selected === "number" ? { selectedLines: selected } : {}) });
    if (hasTaskHome(r.ctx.db, r.taskId)) {
      await recordTaskHomeFile(r.ctx, {
        taskId: r.taskId,
        kind: "research",
        name: "context/pm-read.json",
        content: `${JSON.stringify({ state: pmRead.state, summary: pmRead.summary ?? "", reason: pmRead.reason ?? null }, null, 2)}\n`,
        producer: { node: "pm-read", graph: "lp-task-pipeline", stage_id: "pm-read", run_id: r.runId },
        readers: ["writer", "code-critique"],
      }).catch((cause: unknown) => r.ctx.bb.log.warn(`Lane Pilot: pm-read research of ${r.taskId} was not recorded in its home: ${cause instanceof Error ? cause.message : String(cause)}`));
    }
    return { state: pmRead.state, summary: pmRead.summary, ...(pmRead.reason !== undefined ? { reason: pmRead.reason } : {}), handoff: handoffOf("pm-read", pmRead.state, pmRead.reason) };
  }, {}, "pm-read");

  exec("lp.quality-mode", async (r) => {
    const settings = loadProjectSettings(r.ctx.db, r.projectId, getRunSettingsScopes(r.ctx.db, r.runId));
    return { mode: resolveQualityMode(r.task, settings[QUALITY_MODE_SETTING]) };
  }, { reentrant: true });

  registerExecutionPacketGate(exec, endedReply, blockedReply);

  exec("lp.plan-critique", async (r, ctx) => {
    // A canceled task starts no new helper: the block branch then answers with the ended attempt.
    if (endedReply(r)) return { allowed: false, revisable: false, reason: "attempt ended before its stages finished", handoff: handoffOf("plan-critique", "skipped", "attempt ended") };
    // The critic of every round reads PLAN.md through the task's manifest (docs/task-folder.md): after a planner round that is the revised edition.
    const plan = await stagePlanText(r.ctx, r.taskId, "plan-critique", r.plan);
    await noteStageTaskHomeReads(r.ctx, r.taskId, "plan-critique", ["contract"]).catch(() => undefined);
    const critique = await runPlanCritique({ stageHelperSettings: r.services.stageHelperSettings, bb: r.ctx.bb, db: r.ctx.db, projectId: r.projectId, runId: r.runId, taskId: r.taskId,
      config: r.runConfig, task: r.task, plan, pmReadContext: text(ctx.input.with.pmReadContext) || undefined, workflow: stepRef(ctx) });
    // The verdict as critique/plan.r<K>.json in the task home; a failed record never changes the verdict.
    await recordPlanCritique(r.ctx, { taskId: r.taskId, runId: r.runId, allowed: critique.allowed, reason: critique.reason, wfStepKey: ctx.stepKey })
      .catch((cause: unknown) => r.ctx.bb.log.warn(`Lane Pilot: the plan critique of ${r.taskId} was not recorded in its home: ${cause instanceof Error ? cause.message : String(cause)}`));
    // The planner revises a returned plan when the project says so (plan_critique.revise_by planner), the refusal is one a rewrite of the plan can
    // fix (a rework, or a structural finding in the plan itself), its rounds are not spent, and the PM has not taken the plan over.
    const settings = loadProjectSettings(r.ctx.db, r.projectId, getRunSettingsScopes(r.ctx.db, r.runId));
    const loop = plannerLoopState(engine, ctx.runId);
    const config = planReviseConfig(settings);
    const revisions = loop.revises.filter((row) => row.revised === true).length;
    const pmTookOver = contractEditions(r.ctx.db, r.taskId).some((row) => row.reason === PM_STOPPED_PLANNER_LOOP);
    const revisable = !critique.allowed && critique.revisable === true && config.by === "planner" && revisions < config.maxRounds && !pmTookOver && !endedReply(r);
    return { allowed: critique.allowed, revisable, round: loop.critiques.length + 1, findings: critique.findings ?? [], ...(critique.reason !== undefined ? { reason: critique.reason } : {}),
      handoff: handoffOf("plan-critique", critique.allowed ? "allowed" : revisable ? "returned to the planner" : "blocked", critique.reason) };
  }, {}, "plan-critique");

  // One planner round (SMA n1269, n1267, n22): the planner rewrites the plan the critic returned, in its own session from the second round on; the
  // revision is a new contract edition and the critic judges it again in a fresh session. What the planner cannot fix goes to the PM.
  engine.register<DispatchRuntime>("lp.plan-revise", { run: async (ctx) => {
    const r = need(ctx);
    const loop = plannerLoopState(engine, ctx.runId);
    const settings = loadProjectSettings(r.ctx.db, r.projectId, getRunSettingsScopes(r.ctx.db, r.runId));
    const config = planReviseConfig(settings);
    const round = loop.revises.filter((row) => row.revised === true).length + 1;
    const tried = new Set(loop.revises.flatMap((row) => [row.fromSha, row.planSha]).filter((sha): sha is string => typeof sha === "string"));
    const plannerThreadId = [...loop.revises].reverse().find((row) => typeof row.plannerThreadId === "string")?.plannerThreadId ?? null;
    const base = { round, max: config.maxRounds };
    if (endedReply(r)) return { output: { revised: false, reason: "attempt ended before its stages finished", ...base, handoff: handoffOf("plan-revise", "skipped", "attempt ended") } };
    let outcome: Awaited<ReturnType<typeof runPlanRevise>>;
    try {
      outcome = await runPlanRevise({ bb: r.ctx.bb, db: r.ctx.db, projectId: r.projectId, runId: r.runId, taskId: r.taskId, config: r.runConfig, task: r.task, plan: await stagePlanText(r.ctx, r.taskId, "plan-revise", r.plan), settings,
        round, max: config.maxRounds, findings: roundsOf(loop), plannerThreadId, tried, signal: ctx.signal, workflow: stepRef(ctx) });
    } catch (cause) {
      const reason = `planner_failed:${cause instanceof Error ? cause.message : String(cause)}`;
      return { output: { revised: false, reason, ...base, handoff: handoffOf("plan-revise", "failed", reason) } };
    }
    if (outcome.revised && outcome.plan && outcome.task) {
      r.plan = outcome.plan; r.task = outcome.task;
      // The revision is the task home's new PLAN.md and contract edition (supersedes chain): the next critic reads it through the manifest.
      const homeFailed = await recordPlannerRevision(r.ctx, { taskId: r.taskId, task: outcome.task, plan: outcome.plan });
      if (homeFailed) outcome = { ...outcome, revised: false, reason: homeFailed };
    }
    const output = { revised: outcome.revised, ...base, fromSha: outcome.fromSha, ...(outcome.planSha ? { planSha: outcome.planSha } : {}), ...(outcome.edition !== undefined ? { edition: outcome.edition } : {}),
      ...(outcome.reason ? { reason: outcome.reason } : {}), ...(outcome.plannerThreadId ? { plannerThreadId: outcome.plannerThreadId } : {}),
      handoff: handoffOf("plan-revise", outcome.revised ? `revised (edition ${outcome.edition})` : "not revised", outcome.reason) };
    return { output, ...(outcome.plannerThreadId ? await withUsage(r.ctx.bb, outcome.plannerThreadId) : {}) };
  } });

  exec("lp.block-plan-critique", async (r, ctx) => {
    const ended = endedReply(r);
    if (ended) return { reply: ended };
    const { db } = r.ctx;
    // After the planner loop ran, the PM gets the findings of every round and why the loop ended (SMA n1269: the rounds are spent, then the PM).
    const loop = plannerLoopState(engine, ctx.runId);
    const revisions = loop.revises.filter((row) => row.revised === true).length;
    const config = planReviseConfig(loadProjectSettings(db, r.projectId, getRunSettingsScopes(db, r.runId)));
    const lastRevise = loop.revises.at(-1);
    const stopped = lastRevise && lastRevise.revised !== true ? lastRevise.reason ?? "planner_not_revised" : revisions >= config.maxRounds && revisions > 0 ? "rounds_exhausted" : null;
    // From plan-revise the edge carries the planner's reason; the critic's own reason is that of the last critique.
    const critiqueReason = (loop.revises.length ? loop.critiques.at(-1)?.reason : undefined) ?? text(ctx.input.with.reason);
    const reason = loop.revises.length && stopped
      ? `${stopped === "rounds_exhausted" ? `planner_rounds_exhausted:${revisions}/${config.maxRounds}` : `planner_stopped:${stopped.split(":")[0]}`}: ${critiqueReason ?? "plan-critique did not allow dispatch"}`
      : critiqueReason;
    skipOpenStage(r, "specialist-review", "plan-critique did not allow dispatch");
    skipWriterStages(r, "upstream plan-critique stage did not pass");
    transitionAttempt(db, r.attemptId, "blocked", { reason: reason ?? "plan-critique did not allow dispatch" });
    setRunState(db, r.runId, "blocked");
    const plannerLoop = loop.revises.length ? {
      revisions, maxRounds: config.maxRounds, stopped,
      rounds: roundsOf(loop),
      note: stopped === "rounds_exhausted"
        ? `The planner used its ${revisions} revision round${revisions === 1 ? "" : "s"} and the critic still returns the plan: the findings of every round are in rounds. Fix the plan or the contract in place with lane_pilot_update_task.`
        : stopped ? `The planner stopped (${stopped}): the findings of every round are in rounds. Fix the plan or the contract in place with lane_pilot_update_task.`
        : "The critic's last verdict is not one the planner may fix by rewriting the plan: the findings of every round are in rounds. Fix the plan or the contract in place with lane_pilot_update_task.",
    } : undefined;
    return { reply: { ...blockedReply(r, reason), ...(plannerLoop ? { plannerLoop } : {}) } };
  });

  exec("lp.specialist-review", async (r, ctx) => {
    // A canceled task starts no new helper: the block branch then answers with the ended attempt.
    if (endedReply(r)) return { allowed: false, reason: "attempt ended before its stages finished", handoff: handoffOf("specialist-review", "skipped", "attempt ended") };
    const specialist = await runSpecialistReview({ stageHelperSettings: r.services.stageHelperSettings, bb: r.ctx.bb, db: r.ctx.db, projectId: r.projectId, runId: r.runId, taskId: r.taskId, config: r.runConfig, task: r.task, plan: r.plan, workflow: stepRef(ctx) });
    return { allowed: specialist.allowed, ...(specialist.reason !== undefined ? { reason: specialist.reason } : {}), handoff: handoffOf("specialist-review", specialist.allowed ? "allowed" : "blocked", specialist.reason) };
  }, {}, "specialist-review");

  exec("lp.block-specialist", async (r, ctx) => {
    const ended = endedReply(r);
    if (ended) return { reply: ended };
    const reason = text(ctx.input.with.reason);
    const { db } = r.ctx;
    skipWriterStages(r, "specialist review did not allow dispatch");
    transitionAttempt(db, r.attemptId, "blocked", { reason: reason ?? "specialist review did not allow dispatch" });
    setRunState(db, r.runId, "blocked");
    return { reply: blockedReply(r, reason) };
  });

  // A folder without git has no base commit to measure ownership against: the writer's work is the difference of two
  // content snapshots of the folder.
  exec("lp.ownership-base", async (r) => {
    const { db, host } = r.ctx;
    const live = await r.services.isLiveFolder(r.runId, r.config.hostId, r.workspacePath);
    const gitBase = live ? null : await host.call("gitOwnershipBase", {
      requestedHostId: r.config.hostId, projectCwd: r.workspacePath, ...(r.baseRef === undefined ? {} : { baseRef: r.baseRef }),
    }, { hostId: r.config.hostId, timeoutMs: 30_000 });
    if (gitBase && gitBase.status !== "ready" && (r.baseRef !== undefined || gitBase.status !== "not-git")) {
      return { ok: false, live, kind: "unavailable", reason: `git ownership base unavailable: ${gitBase.reason ?? gitBase.status}` };
    }
    // The base is taken once per task and never changes: a pipeline that goes again (the PM updated the task) keeps the one it has.
    if (gitBase?.status === "ready" && !saveTaskGitBase(db, r.taskId, {
      baseRef: gitBase.baseRef, baseSha: gitBase.baseSha, initialHeadSha: gitBase.headSha!, branch: gitBase.branch!, compareCommitted: gitBase.compareCommitted,
    }) && !getTaskGitBase(db, r.taskId)) {
      return { ok: false, live, kind: "persist_failed", reason: "could not persist immutable git ownership base snapshot" };
    }
    return { ok: true, live };
  });

  exec("lp.block-ownership", async (r, ctx) => {
    const ended = endedReply(r);
    if (ended) return { reply: ended };
    const reason = text(ctx.input.with.reason) ?? "";
    const { db } = r.ctx;
    if (ctx.input.with.kind === "persist_failed") {
      recordStage(db, { runId: r.runId, taskId: r.taskId, stageId: "run-gate", state: "blocked", input: r.plan, result: { decision: "ownership_base_persist_failed" }, reason });
      skipWriterStages(r, reason);
    } else {
      recordStage(db, { runId: r.runId, taskId: r.taskId, stageId: "run-gate", state: "blocked", input: r.plan, result: { decision: "ownership_base_unavailable", baseRef: r.baseRef ?? null }, reason });
      skipWriterStages(r, "git ownership base preflight failed");
    }
    transitionAttempt(db, r.attemptId, "blocked", { reason });
    setRunState(db, r.runId, "blocked");
    r.ctx.refreshRun(r.runId);
    return { reply: blockedReply(r, reason) };
  });

  exec("lp.task-folder", async (r, ctx) => {
    const { bb, host } = r.ctx;
    const live = ctx.input.with.live === true;
    const filecards = await taskFileCards(r.ctx.db as never, r.projectId, r.task).catch(() => undefined);
    // The line goes into the repository's real info/exclude, resolved by git on the workspace's own host — never into a stray `.git` of a
    // subfolder workspace (OVH 2026-10-06). A failed exclude skips only its line.
    const exclude = live ? undefined : async (line: string) => {
      const ran = await runOnHost(host, { hostId: r.config.hostId, cwd: r.workspacePath, command: appendExcludeCommand(line), timeoutSec: 30, timeoutMs: 30_000 });
      if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `git exited ${ran.exitCode}`);
    };
    // A task with a home (docs/task-folder.md) gets its guard notes there, through the manifest. A failed write stops the pipeline: a writer
    // without its folder must not start (it used to be only logged, and the brief then had no plan at all).
    if (hasTaskHome(r.ctx.db, r.taskId)) {
      await exclude?.(TASK_HOME_EXCLUDE).catch((cause: unknown) => bb.log.warn(`Lane Pilot skipped the task-home exclude line: ${cause instanceof Error ? cause.message : String(cause)}`));
      const producer = { node: "task-folder", graph: "lp-task-pipeline", stage_id: "task-folder", wf_step_key: ctx.stepKey };
      const cards = filecardsFileText(filecards ?? []);
      if (cards) await recordTaskHomeFile(r.ctx, { taskId: r.taskId, kind: "filecards", name: "FILECARDS.md", content: cards, producer, readers: ["guard"] });
      return { ok: true };
    }
    // A task dispatched before the switch keeps its old folder to the end (no mixing inside one task); a failed write stops it too.
    try {
      await persistTaskFolder({
        taskId: r.taskId, plan: r.plan,
        filecards, exclude,
        exists: async (rel) => (await orMiss(Promise.resolve().then(() => bb.sdk.files.read({ hostId: r.config.hostId, rootPath: r.workspacePath, path: `${r.workspacePath}/${rel}` })), null, isNotFound)) !== null,
        writeFile: async (rel, content) => {
          await writeReplacing(bb.sdk.files, { hostId: r.config.hostId, rootPath: r.workspacePath, path: `${r.workspacePath}/${rel}`, content, createParents: true });
        },
      });
    } catch (cause) {
      throw new Error(`Lane Pilot could not persist the task folder of ${r.taskId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    return { ok: true };
  });

  // Step [1] of Matvey's task path as a node of its own: the task's checks on the base before any writer (src/rooms/baseline).
  // The writer loop asks the same preflight again and gets this answer from its record: «already built» closes the attempt accepted
  // without a writer there. A stop never reaches the writer: a stopped record is asked again, so it ends here as start.ts ended it.
  exec("lp.baseline", async (r, ctx) => {
    const ended = endedReply(r);
    if (ended) return { state: "skipped", reply: ended };
    const overdue = overdueDeferrals(r.ctx.db as never, r.projectId);
    if (overdue.length > 0) {
      const detail = overdue.slice(0, 5).map((row) => `${row.id} (${row.what.slice(0, 60)})`).join("; ");
      return { state: "stopped", reason: `verdict_block: overdue_deferral: expired deferral blocks baseline: ${detail}` };
    }
    if (ctx.input.with.live === true || isMainfixTask(r.taskId)) return { state: "skipped" };
    const baseline = await r.services.baseline?.preflight({ projectId: r.projectId, runId: r.runId, taskId: r.taskId, attemptId: r.attemptId,
      pmThreadId: r.threadId, config: r.runConfig, task: r.task });
    if (baseline?.stop) return { state: "stopped", reason: baseline.stop };
    if (baseline?.alreadyDone) return { state: "already_built", reason: baseline.alreadyDone };
    return { state: baseline?.record ? "red" : "skipped" };
  });

  exec("lp.block-baseline", async (r, ctx) => {
    const ended = endedReply(r);
    if (ended) return { reply: ended };
    const reason = text(ctx.input.with.reason) ?? "verdict_block: baseline";
    const { db } = r.ctx;
    transitionAttempt(db, r.attemptId, "blocked", { reason });
    closeWriterStages(db, { runId: r.runId, taskId: r.taskId, plan: r.plan, terminal: "failed", attempt: countAttempts(db, r.runId, r.taskId), reason });
    r.ctx.refreshRun(r.runId);
    return { reply: blockedReply(r, reason) };
  });

  const pipelineExecutor = lpTaskPipelineExecutor(engine, bb);
  // The chain executor of the same key, when it is already on the engine, multiplexes to this pipeline by the runtime's
  // attemptId — registering over it would route a chain's code tasks here with the wrong runtime (server.ts order).
  if (!engine.hasExecutor("lp-task")) engine.register<DispatchRuntime>("lp-task", pipelineExecutor);
  provideLpTaskPipeline(engine, pipelineExecutor);
  registerAttemptGraphExecutors(engine, createDispatchRuntimeResolver(engine, bb, () => engineServices.get(engine)));
  registerWriterFallbackExecutors(engine, need, bb);
}

/**
 * The code task of the per-task pipeline: Lane Pilot's own writer loop (start.ts, finish.ts) runs it; this step starts it and then
 * waits for the attempt. A chain's `lp-task` node (workflow-executors.ts) goes through the same executor key and hands a dispatch run's step to this.
 */
export function lpTaskPipelineExecutor(engine: WorkflowEngine, bb?: BbPluginApi): NodeExecutor<DispatchRuntime> {
  return {
    run: async (ctx) => {
      const r = need(ctx);
      const { db } = r.ctx;
      const pmReadContext = text(ctx.input.with.pmReadContext) ?? "";
      let attemptId = r.attemptId;
      const existing = getAttempt(db, attemptId);
      if (existing && TERMINAL_ATTEMPT.includes(existing.state)) {
        // Subsequent visits along `writer -> writer` start a new attempt and reopen failed stages.
        attemptId = id("lpattempt");
        createAttempt(db, { id: attemptId, runId: r.runId, taskId: r.taskId });
        reopenWriterStages(db, r.runId, r.taskId, r.plan);
      } else {
        // A cancel during the stages ends the queued attempt: the writer must not start for it.
        const ended = endedReply(r);
        if (ended) {
          const cls = failureClass(String(ended.state ?? "blocked"), typeof ended.reason === "string" ? ended.reason : null);
          return { output: { reply: { ...ended, failureClass: cls, retryable: false } } };
        }
        transitionAttempt(db, attemptId, "queued");
      }
      r.services.startWriterTask({
        projectId: r.projectId, runId: r.runId, taskId: r.taskId, firstAttemptId: attemptId,
        pmThreadId: r.threadId, config: r.runConfig, task: r.task, plan: r.plan, pmReadContext: pmReadContext || undefined,
      });
      // The writer's brief carries the read stage's facts, not its open questions: those are the PM's to settle.
      const openQuestions = pmReadContext ? pmReadBrief(pmReadContext).openQuestions : [];
      const warnings: string[] = [...r.lintWarnings];
      if (ctx.input.with.live === true) warnings.push("mode live-folder: this folder has no git. The writer edits the live files in place; nothing is committed or merged, so there is no ship step. One writer at a time works in the folder, later tasks queue. A task that is not accepted is rolled back from a backup of its owns_paths (~/.lane-pilot/live-backups, kept 7 days); files outside owns_paths are not rolled back.");
      const reply = { runId: r.runId, taskId: r.taskId, attemptId, writerThreadId: null, state: "queued", stages: listStageReceipts(db, r.runId, r.taskId),
        ...(warnings.length ? { warnings } : {}),
        ...(openQuestions.length ? { pmReadOpenQuestions: openQuestions,
          pmReadNote: "The writer does not see these questions. If one changes what the writer should do, wait for this attempt's receipt and, if it is not accepted, dispatch again with the answer in the plan; otherwise the writer decides from the code." } : {}) };
      return { wait: { kind: "attempt", detail: { runId: r.runId, taskId: r.taskId, attemptId } }, partial: { reply } };
    },
    /** The step ends when the task's latest attempt does. A retry is a new attempt of the same task, so the latest one counts. */
    poll: async (step, ctx) => {
      const detail = step.await.detail as { runId: string; taskId: string } | undefined;
      if (!detail) return { error: "the waiting step does not say which task it waits for" };
      return pollAttempt(engine, detail.runId, detail.taskId, bb ?? ctx.runtime?.ctx.bb);
    },
  };
}

/** The engine key of an attempt's dispatch run; a restart after a reload is a run of its own (`:resume-N`). */