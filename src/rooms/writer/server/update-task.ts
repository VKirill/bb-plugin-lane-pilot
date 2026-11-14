import { relative, resolve } from "node:path";
import type { VerificationGatePort } from "../../contracts/integration-gate";
import type { IsTaskSatisfied } from "../../contracts";
import type { StageHelperSettings, WorkflowEngineApi } from "../../platform/server";
import { isDeepStrictEqual } from "node:util";
import { DISPATCH_STAGES_PENDING } from "../../runs";
import { taskV2Schema } from "../../contracts";
import type { TaskV2 } from "../../contracts";
import {
  countAttempts,
  getAttempt,
  getRun,
  getTask,
  getTaskPlan,
  listAttemptsForTask,
  listRunTaskRows,
  listStageReceipts,
  transitionAttempt,
  saveTaskPlan,
  updateTaskContract,
  contractEditions,
  hasTaskHome,
} from "../../storage";


import type { BaselineApi } from "../../baseline/server/baseline";
import type { StabilityApi } from "../../stability/server/stability";
import type { WriterSpawnApi } from "./spawn";
import type { WriterStartApi } from "./start";
import type { WriterStateApi } from "./state";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  stageHelperSettings: StageHelperSettings;
  activeWriterTasks: WriterStateApi["activeWriterTasks"];
  baseline: BaselineApi;
  isLiveFolder: WriterSpawnApi["isLiveFolder"];
  isTaskSatisfied: IsTaskSatisfied;
  stability: StabilityApi;
  resolveIntegrationGate: VerificationGatePort;
  startWriterTask: WriterStartApi["startWriterTask"];
  workflowEngine: WorkflowEngineApi["workflowEngine"];
}
import { lintReply } from "../../tasks/server";
import { createTaskLinter } from "../../tasks/server";
const FINISHED_ATTEMPT_STATES = ["accepted", "canceled", "merged"];
import { sendServiceMessage } from "../../relay/server";
import { markTaskSatisfied, reopenWriterStages } from "../../runs/server";
import type { ServerCore } from "../../contracts/server";

import { validateTaskV2 } from "../../tasks/task-v2";
import { TEST_EDIT_HOLD_ITEM, allowTestEditsOf, applyTrustedTooling, testEditHoldOf } from "../../tasks";
import { closeOwnerItemsByPrefix } from "../../owner-waiting";
import { planWithOutsideReads, planWithRepoScope, rerootTask, rerootToRepoRoot } from "../../tasks";
import { appendExcludeCommand, persistTaskFolder } from "../../verification";
import { runOnHost } from "@lane-pilot/host-calls";
import { isNotFound, orMiss } from "@lane-pilot/kit";
import { dispatchRunOf, plannerLoopActive, rerunDispatchStages } from "./dispatch-workflow";
import { PM_STOPPED_PLANNER_LOOP } from "./plan-revise";
import { noteTaskQa, awaitsWriterAnswer, contractFixRecord, contractFixTurnPrompt, createAttemptReopen, writerQuestion } from "./reopen-attempt";
import { pendingWordPush } from "./writer-task";
import { openAttemptWorktree, recordTaskEdition } from "./task-home";
import { reflexLinesOf, taskFileCards } from "./writer-knowledge";
import { writerDiffRules } from "../../learning";
import type { FieldChange } from "./reopen-attempt";

/** How long an update waits for the stages that go again before it answers «queued». */
const STAGES_WAIT_MS = 240_000;

/** What a PM may change on a task its writer is waiting on a question about; any other field needs a redispatch. */
const IN_PLACE_FIELDS: readonly string[] = ["verification", "acceptance", "expected_outputs", "owns_paths", "never_touch", "plan", "display_title", "kind"];

/** Reasons of a block that happened before any writer: the plan critique (structural, model verdict or its own fault) and the contract validation. */
const PRE_WRITER_GATE_REASON = /^(?:structural_plan_critique|plan_critique|verdict_block:plan-critique|validation_failed|planner_rounds_exhausted|planner_stopped)/;

/** The top-level fields whose values differ between two contracts. */
function changedFields(before: TaskV2, after: TaskV2): FieldChange[] {
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])] as Array<keyof TaskV2>;
  return fields
    .filter((field) => !isDeepStrictEqual(before[field], after[field]))
    .map((field) => ({ field, from: before[field], to: after[field] }));
}

export function createWriterUpdateTask(ctx: ServerCore, services: Services) {
  const { bb, db, host, log } = ctx;
  const lintTask = createTaskLinter(ctx, services);
  const reopen = createAttemptReopen(ctx, services);

  /** Writes PLAN.md into the task folder; a failed write is logged and never fails the update. */
  async function persistPlan(hostId: string, workspacePath: string, taskId: string, plan: string, extra?: { projectId?: string; task?: TaskV2 }): Promise<void> {
    // A task with a home (docs/task-folder.md): a new contract.v<N>.json and PLAN.md there, and again in its open worktree. No old folder.
    if (hasTaskHome(db, taskId)) {
      const task = extra?.task ?? (getTask(db, taskId)?.contract as TaskV2 | undefined);
      if (task) await recordTaskEdition(ctx, { taskId, task, plan, mirrorRoot: openAttemptWorktree(db, taskId, workspacePath) })
        .catch((cause: unknown) => bb.log.warn(`Lane Pilot could not record the new edition of ${taskId} in its home: ${cause instanceof Error ? cause.message : String(cause)}`));
      return;
    }
    try {
      await persistTaskFolder({
        taskId,
        plan,
        // The project's accepted WHEN → act rules reach the writer's guard as REFLEXES.md (SMA k_hs_reflex); the
        // paths' stored notes as FILECARDS.md (SMA k_hs_context).
        reflexes: extra?.projectId ? reflexLinesOf(writerDiffRules(db as never, extra.projectId)) : undefined,
        filecards: extra?.projectId && extra.task ? await taskFileCards(db as never, extra.projectId, extra.task).catch(() => undefined) : undefined,
        exclude: async (line) => {
          const ran = await runOnHost(host, { hostId, cwd: workspacePath, command: appendExcludeCommand(line), timeoutSec: 30, timeoutMs: 30_000 });
          if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `git exited ${ran.exitCode}`);
        },
        exists: async (rel) => (await orMiss(Promise.resolve().then(() => bb.sdk.files.read({ hostId, rootPath: workspacePath, path: `${workspacePath}/${rel}` })), null, isNotFound)) !== null,
        writeFile: async (rel, content) => {
          await bb.sdk.files.write({
            hostId,
            rootPath: workspacePath,
            path: `${workspacePath}/${rel}`,
            content,
            contentEncoding: "utf8",
            createParents: true,
            expectedSha256: null,
          });
        },
      });
    } catch (cause) {
      bb.log.warn(`Lane Pilot could not persist task folder for ${taskId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  async function updateTask(input: {
    projectId: string;
    runId: string;
    pmThreadId: string;
    taskId: string;
    task?: TaskV2;
    plan?: string;
    /** The task is blocked and the PM verified its work: tasks that depend on it go on without a follow-up task. */
    satisfied?: boolean;
    /** A word for the task's running writer, with no contract change (sma as_wheel): now, at its next turn, or kept for the task. */
    note?: string;
    when?: "now" | "next_turn" | "task";
    /** On a test_edit_hold-blocked task: the person allows exactly the edits the hold recorded (sma av_test_edit_hold). */
    allowTestEdits?: boolean;
  }): Promise<Record<string, unknown>> {
    const run = getRun(db, input.runId);
    if (!run || run.project_id !== input.projectId || run.pm_thread_id !== input.pmThreadId) {
      return {
        ok: false,
        error: { code: "not_pm_thread", retryable: false, sideEffects: "none", hint: "run does not belong to caller PM thread" },
      };
    }
    const row = getTask(db, input.taskId);
    if (!row || row.run_id !== input.runId || row.kind !== "bb") {
      return {
        ok: false,
        error: { code: "task_not_found", retryable: false, sideEffects: "none", hint: `no such task in this run: ${input.taskId}` },
      };
    }

    const attempts = listAttemptsForTask(db, input.runId, input.taskId);
    const latestAttempt = attempts.at(-1);
    if (!latestAttempt) {
      return {
        ok: false,
        error: { code: "task_not_found", retryable: false, sideEffects: "none", hint: `task has no attempts: ${input.taskId}` },
      };
    }

    if (input.satisfied) {
      if (input.task || input.plan) {
        return { ok: false, error: { code: "validation_failed", retryable: false, sideEffects: "none", hint: "satisfied:true takes no task or plan" } };
      }
      if (latestAttempt.state !== "blocked") {
        return { ok: false, error: { code: "not_blocked", retryable: false, sideEffects: "none", hint: `only a blocked task can be marked satisfied; ${input.taskId} is ${latestAttempt.state}` } };
      }
      await markTaskSatisfied(bb.storage.kv as never, input.projectId, input.taskId, "verified by the PM");
      ctx.log(`task ${input.taskId} marked satisfied by its PM: its dependents proceed`);
      return { ok: true, runId: input.runId, taskId: input.taskId, state: "satisfied",
        hint: "Tasks that depend on it start by themselves; the task itself stays blocked in the record." };
    }

    const attempt = getAttempt(db, latestAttempt.id);
    // Inside the planner loop the PM may take the plan over (SMA n1269 ends at the PM): the update stops the loop, the critique runs on the PM's plan.
    const inPlannerLoop = attempt?.reason === DISPATCH_STAGES_PENDING && plannerLoopActive(db, input.runId, input.taskId);
    if (attempt?.reason === DISPATCH_STAGES_PENDING && !inPlannerLoop) {
      return {
        ok: false,
        error: { code: "dispatch_in_progress", retryable: true, sideEffects: "none", hint: "The task's pm-read and plan critique are still running; update it once they finish." },
      };
    }
    // A blocked task whose writer asked a question is fixed in place below; any other started task is refused.
    const blocked = attempt && awaitsWriterAnswer(attempt) ? attempt : null;
    // A pre-writer gate (plan critique, contract validation) blocked this attempt before it ever had a writer thread:
    // the task never started, so it is fixed in place like a queued one and pm-read and the critique run again.
    const gateBlocked = !blocked && attempt?.state === "blocked" && !attempt.thread_id && PRE_WRITER_GATE_REASON.test(attempt.reason ?? "");
    // Finished work is never rewritten (SMA tb_words).
    if (attempt && FINISHED_ATTEMPT_STATES.includes(attempt.state)) {
      return {
        ok: false,
        error: { code: "task_finished", retryable: false, sideEffects: "none", hint: `task ${input.taskId} ended ${attempt.state}: its words are final. For new work dispatch a new task.` },
      };
    }
    // Words may change while the task runs (SMA tb_words): the contract and plan are stored, and the live writer is
    // steered with the changes — no attempt is spent. Fields outside IN_PLACE_FIELDS still need a redispatch.
    const running = !blocked && !gateBlocked && attempt?.state === "running" && attempt.thread_id ? attempt : null;
    // A bare note for a running writer is the wheel (sma as_wheel), not a contract change: it slips the started refusal.
    const wheeled = !blocked && !gateBlocked && input.note !== undefined && attempt?.state === "running" && attempt.thread_id ? attempt : null;
    // A hand-in held on weakened reference tests waits for the person's allow of that exact edit (sma av_test_edit_hold).
    const testHeld = !blocked && !gateBlocked && input.allowTestEdits === true && attempt?.state === "blocked" && /^test_edit_hold:/.test(attempt.reason ?? "") ? attempt : null;
    if (!blocked && !gateBlocked && !running && !wheeled && !testHeld && (attempt?.thread_id || attempt?.state !== "queued")) {
      return {
        ok: false,
        error: {
          code: "task_started",
          retryable: false,
          sideEffects: "none",
          hint: "The task has already started. Answer the writer with lane_pilot_answer_writer if it stopped with a question, send a note for a word into its live session, or cancel and redispatch.",
        },
      };
    }
    if (input.note !== undefined && !wheeled) {
      return {
        ok: false,
        error: { code: "task_not_running", retryable: false, sideEffects: "none",
          hint: `a note goes to a running writer; ${input.taskId} is ${attempt?.state ?? "unknown"}. Update its contract or plan instead, or wait for the attempt.` },
      };
    }
    if (input.note !== undefined && (input.task || input.plan)) {
      return {
        ok: false,
        error: { code: "validation_failed", retryable: false, sideEffects: "none", hint: "a note goes alone: send no task or plan with it" },
      };
    }
    if (input.allowTestEdits !== undefined && (!input.allowTestEdits || input.task || input.plan || input.note !== undefined)) {
      return {
        ok: false,
        error: { code: "validation_failed", retryable: false, sideEffects: "none", hint: "allowTestEdits:true goes alone: send no task, plan or note with it" },
      };
    }
    if (input.allowTestEdits === true && !testHeld) {
      return {
        ok: false,
        error: { code: "not_test_edit_held", retryable: false, sideEffects: "none",
          hint: `only a task whose hand-in waits on test_edit_hold can be allowed; ${input.taskId} is ${attempt?.state ?? "unknown"}${attempt?.reason ? ` (${attempt.reason.slice(0, 120)})` : ""}` },
      };
    }

    const workspacePath = run.writer_workspace_path;
    if (!workspacePath) {
      return {
        ok: false,
        error: { code: "no_workspace", retryable: false, sideEffects: "none", hint: "run has no persisted writerWorkspacePath" },
      };
    }

    // A chat that switched Lane Pilot on in the composer runs as kind `cli` and has no project prototype config: its run's config is
    // the one dispatch and the writer answer use (owner's Vampirism Fire PM, 2026-10-23: update_task said «not configured» twice).
    const config = await ctx.configForRun(input.projectId, run);
    if (!config) {
      return {
        ok: false,
        error: { code: "not_configured", retryable: false, sideEffects: "none", hint: `Lane Pilot prototype is not configured for ${input.projectId}` },
      };
    }
    const runConfig = { ...config, writerWorkspacePath: workspacePath };

    if (testHeld) {
      // The allowance binds the held edits' content hashes: the file changed again is a new edit and holds again.
      const held = await testEditHoldOf(bb.storage.kv as never, testHeld.id);
      if (!held.length) {
        return { ok: false, error: { code: "not_test_edit_held", retryable: false, sideEffects: "none", hint: `no held edits recorded for attempt ${testHeld.id}; redispatch the task` } };
      }
      await allowTestEditsOf(bb.storage.kv as never, testHeld.id, held);
      try { closeOwnerItemsByPrefix(db as never, `${TEST_EDIT_HOLD_ITEM}${testHeld.id}`, "approved:pm"); } catch { /* the janitor takes it later */ }
      const paths = held.map((row) => row.path);
      const ready = await reopen.checkReopenable({ runId: input.runId, taskId: input.taskId, run, attempt: testHeld });
      if (!ready.ok) {
        return { ok: false, error: { code: "not_reopenable", retryable: false, sideEffects: "none",
          hint: `the edits are allowed but the attempt cannot reopen: ${ready.hint}` } };
      }
      const reopened = await reopen.reopenAttempt({
        projectId: input.projectId, runId: input.runId, taskId: input.taskId, pmThreadId: input.pmThreadId,
        attempt: testHeld, threadId: ready.threadId, workspacePath: ready.workspacePath, config, contract: taskV2Schema.parse(row.contract),
        reason: "the person allowed the reference-test edits",
        turn: `Lane Pilot: the person allowed your edit of ${paths.join(", ")} exactly as it is. Hand the task in again; any further change to a reference test holds the hand-in again.`,
        qaAnswer: `allowed reference-test edits: ${paths.join(", ")}`,
      });
      if (!reopened.ok) return { ok: false, error: { code: "not_reopenable", retryable: false, sideEffects: "none", hint: reopened.hint } };
      log(`writer ${input.taskId}: reference-test edits allowed by the person (${paths.join(", ")}); attempt ${testHeld.id} reopens`);
      return { ok: true, runId: input.runId, taskId: input.taskId, attemptId: testHeld.id, writerThreadId: ready.threadId, state: "running",
        allowed: paths,
        note: "The hand-in finishes under the allowance: the same file changed again holds anew. The allowance is kept in the task folder's QA.md." };
    }

    if (wheeled) {
      const text = input.note!.trim().slice(0, 2000);
      if (!text) {
        return { ok: false, error: { code: "validation_failed", retryable: false, sideEffects: "none", hint: "the note is empty" } };
      }
      const when = input.when ?? "now";
      let delivered = false;
      if (when !== "task") {
        // A word thrown at a live thread that no longer takes it is not lost: it is kept for the next attempt
        // (sma as_redirect_deferred).
        delivered = await sendServiceMessage(bb, { threadId: wheeled.thread_id!, mode: when === "now" ? "steer-if-active" : "queue-if-active",
          text: `Lane Pilot: the PM corrected the task while you work: ${text}`, senderThreadId: input.pmThreadId }).then(() => true, () => false);
        if (delivered && getAttempt(db, wheeled.id)?.state !== "running") delivered = false;
      }
      if (!delivered) await pendingWordPush(bb.storage.kv as never, input.runId, input.taskId, text);
      const qaPath = getAttempt(db, wheeled.id)?.workspace_path ?? workspacePath;
      await noteTaskQa(ctx, { hostId: config.hostId, workspacePath: qaPath, taskId: input.taskId, attemptId: wheeled.id, question: `the PM's word (${when})`, answer: text });
      log(`writer ${input.taskId}: the PM's word ${delivered ? `reached the running writer (${when})` : "is kept for the next attempt"}`);
      return { ok: true, runId: input.runId, taskId: input.taskId, attemptId: wheeled.id, state: "running", delivered, when,
        note: delivered ? "The word reached the writer's thread and is recorded in the task folder's QA.md."
          : "The writer's thread could not take it now; it is kept and rides the next attempt's brief, and is recorded in QA.md." };
    }

    const oldContract = taskV2Schema.parse(row.contract);
    const updatedContract = input.task ? { ...input.task, id: input.taskId } : oldContract;
    const oldPlan = getTaskPlan(db, input.taskId) ?? oldContract.objective;
    let canonicalPlan = input.plan ?? (input.task ? updatedContract.objective : oldPlan);

    if (canonicalPlan.trim().length === 0) {
      return {
        ok: false,
        error: { code: "invalid_plan", retryable: false, sideEffects: "none", hint: "canonical plan must be non-empty" },
      };
    }

    const valid = validateTaskV2(updatedContract);
    if (!valid.ok) {
      return {
        ok: false,
        error: { code: "validation_failed", retryable: false, sideEffects: "none", hint: `task-v2 invalid: ${valid.errors.join("; ")}` },
      };
    }
    // The task keeps the checkout it was dispatched into: the run's folder, or the git repository inside it the task moved
    // into. The PM may send the contract as it wrote it (paths from the run's folder); it moves the same way again.
    const taskBase = oldContract.project_cwd;
    // repo_scope is dispatch's alone: an update keeps it on a task that has it and never gives it to one that has not.
    const scoped = oldContract.repo_scope === true;
    delete valid.task.repo_scope;
    if (resolve(valid.task.project_cwd) === resolve(taskBase)) { valid.task.project_cwd = taskBase; if (scoped) valid.task.repo_scope = true; }
    else {
      const fromRun = resolve(valid.task.project_cwd) === resolve(workspacePath) && resolve(taskBase) !== resolve(workspacePath);
      const section = scoped ? relative(taskBase, workspacePath).split("\\").join("/") : "";
      const up = scoped && fromRun ? rerootToRepoRoot({ ...valid.task, project_cwd: workspacePath }, taskBase, section) : null;
      const moved = up ? { task: up.task, outsideReads: [] as string[] } : fromRun && !scoped ? rerootTask({ ...valid.task, project_cwd: workspacePath }, relative(workspacePath, taskBase).split("\\").join("/")) : null;
      if (!moved) {
        const hint = resolve(taskBase) === resolve(workspacePath) ? `task.project_cwd must equal the configured writerWorkspacePath (${workspacePath})`
          : `task.project_cwd must equal ${taskBase}, the repository this task works in, or ${workspacePath} with every owned path, expected output and check inside that repository`;
        return { ok: false, error: { code: "validation_failed", retryable: false, sideEffects: "none", hint } };
      }
      valid.task = moved.task;
      canonicalPlan = up ? planWithRepoScope(canonicalPlan, taskBase, section, up.outside) : planWithOutsideReads(canonicalPlan, moved.outsideReads);
    }
    const taskConfig = { ...runConfig, writerWorkspacePath: taskBase };

    // A task stored before the trusted tooling joined never_touch (P2-4) is compared as it would be stored now, so no change is invented.
    const changes = changedFields(applyTrustedTooling(oldContract), valid.task);
    if (canonicalPlan !== oldPlan) changes.push({ field: "plan", from: oldPlan, to: canonicalPlan });
    if (blocked || running) {
      const frozen = changes.map((change) => change.field).filter((field) => !IN_PLACE_FIELDS.includes(field));
      if (frozen.length) {
        return {
          ok: false,
          error: { code: "redispatch_required", retryable: false, sideEffects: "none",
            hint: `the task ${blocked ? "is blocked on its writer's question" : "is running"}, so only ${IN_PLACE_FIELDS.join(", ")} change in place; ${frozen.join(", ")} need a redispatch: cancel the task and dispatch it again` },
        };
      }
      if (!changes.length) {
        return {
          ok: false,
          error: { code: "validation_failed", retryable: false, sideEffects: "none",
            hint: `the task's contract and plan are unchanged: send the corrected fields${blocked ? ", or answer the writer with lane_pilot_answer_writer" : ""}` },
        };
      }
    }

    // The same contract lint as dispatch: every contract mistake goes back to the PM in one message, before the stored task changes.
    const linted = await lintTask(input.projectId, input.runId, valid.task, taskBase, config.hostId, listRunTaskRows(db, input.runId).find((row) => row.id === valid.task.id)?.birth as never);
    // A blocked task keeps its area (a change needs a redispatch), so one dispatched before the task standard is not refused for lacking it.
    const lint = { ...linted, errors: blocked && !oldContract.area ? linted.errors.filter((error) => error.code !== "area_missing") : linted.errors };
    if (lint.errors.length) {
      const { runId: _runId, state: _state, reason: _reason, ...rest } = lintReply(input.runId, lint.errors);
      const hint = `contract lint: the task was not changed. Fix and send the update again:\n${lint.errors.map((error) => `- ${error.message}`).join("\n")}`;
      return { ok: false, error: { code: "validation_failed", retryable: false, sideEffects: "none", hint, ...rest } };
    }

    if (running) {
      // Stored first, as for a queued task; then the live writer thread is steered with what changed.
      updateTaskContract(db, input.taskId, valid.task);
      saveTaskPlan(db, input.taskId, canonicalPlan);
      await persistPlan(config.hostId, taskBase, input.taskId, canonicalPlan, { projectId: input.projectId, task: valid.task });
      await sendServiceMessage(bb as never, { threadId: running.thread_id!, mode: "steer-if-active", senderThreadId: input.pmThreadId,
        text: contractFixTurnPrompt({ question: "the PM changed the task's words while you work — apply the changed contract from now on", changes }) });
      log(`writer ${input.taskId}: contract steered mid-run (${changes.map((change) => change.field).join(", ")}); attempt ${running.id} continues`);
      return { ok: true, runId: input.runId, taskId: input.taskId, attemptId: running.id, writerThreadId: running.thread_id, state: "running",
        changed: changes.map((change) => change.field), edition: contractEditions(db, input.taskId).at(-1)?.edition,
        note: "The writer continues in its own thread and worktree under the changed contract; no attempt was spent. Poll lane_pilot_wait_writer with the same runId." };
    }

    if (blocked) {
      const ready = await reopen.checkReopenable({ runId: input.runId, taskId: input.taskId, run, attempt: blocked });
      if (!ready.ok) return { ok: false, error: { code: "not_reopenable", retryable: false, sideEffects: "none", hint: ready.hint } };

      // Stored and written before the writer restarts, as for a queued task.
      updateTaskContract(db, input.taskId, valid.task);
      saveTaskPlan(db, input.taskId, canonicalPlan);
      await persistPlan(config.hostId, taskBase, input.taskId, canonicalPlan, { projectId: input.projectId, task: valid.task });
      const reopened = await reopen.reopenAttempt({
        projectId: input.projectId, runId: input.runId, taskId: input.taskId, pmThreadId: input.pmThreadId,
        attempt: blocked, threadId: ready.threadId, workspacePath: ready.workspacePath, config, contract: valid.task,
        reason: "the PM fixed the contract in place",
        turn: contractFixTurnPrompt({ question: writerQuestion(blocked.reason), changes }),
        qaAnswer: contractFixRecord(changes),
      });
      if (!reopened.ok) {
        // Nothing reached the writer: the stored task and its PLAN.md go back as they were.
        updateTaskContract(db, input.taskId, row.contract);
        saveTaskPlan(db, input.taskId, oldPlan);
        await persistPlan(config.hostId, taskBase, input.taskId, oldPlan, { projectId: input.projectId, task: row.contract as TaskV2 });
        return { ok: false, error: { code: "not_reopenable", retryable: false, sideEffects: "none", hint: reopened.hint } };
      }
      log(`writer ${input.taskId}: contract fixed in place (${changes.map((change) => change.field).join(", ")}); attempt ${blocked.id} continues`);
      return { ok: true, runId: input.runId, taskId: input.taskId, attemptId: blocked.id, writerThreadId: ready.threadId, state: "running",
        changed: changes.map((change) => change.field), edition: contractEditions(db, input.taskId).at(-1)?.edition,
        note: "The writer continues in its own thread and worktree under the fixed contract; no attempt was spent. Poll lane_pilot_wait_writer with the same runId. The change is kept in the task folder's QA.md." };
    }

    // The pm-read and the plan critique go again through the task's pipeline run (the graph), so that run must exist and the engine be up.
    const engine = services.workflowEngine;
    if (!engine) {
      return { ok: false, error: { code: "engine_unavailable", retryable: true, sideEffects: "none", hint: "the workflow engine is not running; the task was not changed. Try again in a minute." } };
    }
    if (!dispatchRunOf(db, input.runId, input.taskId)) {
      return { ok: false, error: { code: "pipeline_run_missing", retryable: false, sideEffects: "none", hint: `${input.taskId} has no pipeline run to go again; cancel the task and dispatch it again.` } };
    }

    // Save updated contract and plan in database; an update inside the planner loop says so in its edition, and the planner revises no more.
    saveTaskPlan(db, input.taskId, canonicalPlan);
    updateTaskContract(db, input.taskId, valid.task, inPlannerLoop ? PM_STOPPED_PLANNER_LOOP : null);

    // Persist PLAN.md to task folder
    await persistPlan(config.hostId, taskBase, input.taskId, canonicalPlan, { projectId: input.projectId, task: valid.task });

    // The stages go again from pm-read through the task's pipeline run; while they do, the attempt says so and a second update waits.
    transitionAttempt(db, latestAttempt.id, "queued", { reason: DISPATCH_STAGES_PENDING });
    // A gate's block left the writer stages skipped; the writer could never start again («illegal stage transition writer-agent:
    // skipped -> running», live 2026-11-03 twice). They open as pending, as for a parked task.
    if (gateBlocked) reopenWriterStages(db, input.runId, input.taskId, "the PM fixed in place the contract a pre-writer gate refused");
    ctx.refreshRun?.(input.runId);
    const rerun = await rerunDispatchStages(engine, {
      ctx, services, threadId: input.pmThreadId, projectId: input.projectId, runId: input.runId, taskId: input.taskId, attemptId: latestAttempt.id,
      config, runConfig: taskConfig, workspacePath: taskBase, task: valid.task, plan: canonicalPlan, lintWarnings: [],
    }, STAGES_WAIT_MS);
    if (!rerun.ok) {
      // Nothing went again: the stored task and its PLAN.md go back as they were, and a gate-blocked attempt keeps its block.
      transitionAttempt(db, latestAttempt.id, gateBlocked ? "blocked" : "queued", gateBlocked && attempt?.reason ? { reason: attempt.reason } : {});
      ctx.refreshRun?.(input.runId);
      updateTaskContract(db, input.taskId, row.contract);
      saveTaskPlan(db, input.taskId, oldPlan);
      await persistPlan(config.hostId, taskBase, input.taskId, oldPlan, { projectId: input.projectId, task: row.contract as TaskV2 });
      return { ok: false, error: { code: "rerun_refused", retryable: false, sideEffects: "none", hint: `the task's stages could not go again (${rerun.reason}); the task was not changed. Cancel it and dispatch it again.` } };
    }
    const critique = rerun.critique;
    const state = getAttempt(db, latestAttempt.id)?.state ?? "queued";

    return {
      ok: true,
      runId: input.runId,
      taskId: input.taskId,
      state,
      edition: contractEditions(db, input.taskId).at(-1)?.edition,
      stages: listStageReceipts(db, input.runId, input.taskId),
      ...(critique ? { critiqueAllowed: critique.allowed } : {}),
      ...(critique?.reason ? { critiqueReason: critique.reason } : {}),
      ...(rerun.settled ? {} : { stagesPending: true, note: "pm-read and plan critique are still running again; the writer starts by itself once they pass." }),
    };
  }

  return { updateTask };
}
