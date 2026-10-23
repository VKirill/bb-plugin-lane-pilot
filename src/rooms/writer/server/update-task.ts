import { relative, resolve } from "node:path";
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
  listStageReceipts,
  saveTaskPlan,
  updateTaskContract,
} from "../../storage";
import { lintReply } from "../../tasks/server";
import { createTaskLinter } from "../../tasks/server";
import { runPlanCritique, runPmRead } from "../../critique/server";
import { recordStage } from "../../runs/server";
import { markTaskSatisfied } from "../../runs/server";
import type { ServerCore } from "../../core/server";
import type { Services } from "../../core/server";
import { validateTaskV2 } from "../../tasks/task-v2";
import { applyTrustedTooling } from "../../tasks";
import { planWithOutsideReads, rerootTask } from "../../tasks";
import { appendExcludeCommand, persistTaskFolder } from "../../verification";
import { runOnHost } from "@lane-pilot/host-calls";
import { awaitsWriterAnswer, contractFixRecord, contractFixTurnPrompt, createAttemptReopen, writerQuestion } from "./reopen-attempt";
import type { FieldChange } from "./reopen-attempt";

/** What a PM may change on a task its writer is waiting on a question about; any other field needs a redispatch. */
const IN_PLACE_FIELDS: readonly string[] = ["verification", "acceptance", "expected_outputs", "owns_paths", "never_touch", "plan", "display_title", "kind"];

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
  async function persistPlan(hostId: string, workspacePath: string, taskId: string, plan: string): Promise<void> {
    try {
      await persistTaskFolder({
        taskId,
        plan,
        exclude: async (line) => {
          const ran = await runOnHost(host, { hostId, cwd: workspacePath, command: appendExcludeCommand(line), timeoutSec: 30, timeoutMs: 30_000 });
          if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `git exited ${ran.exitCode}`);
        },
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
    if (attempt?.reason === DISPATCH_STAGES_PENDING) {
      return {
        ok: false,
        error: { code: "dispatch_in_progress", retryable: true, sideEffects: "none", hint: "The task's pm-read and plan critique are still running; update it once they finish." },
      };
    }
    // A blocked task whose writer asked a question is fixed in place below; any other started task is refused.
    const blocked = attempt && awaitsWriterAnswer(attempt) ? attempt : null;
    if (!blocked && (attempt?.thread_id || attempt?.state !== "queued")) {
      return {
        ok: false,
        error: {
          code: "task_started",
          retryable: false,
          sideEffects: "none",
          hint: "The task has already started. Answer the writer with lane_pilot_answer_writer if it stopped with a question, or cancel and redispatch.",
        },
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
    if (resolve(valid.task.project_cwd) === resolve(taskBase)) valid.task.project_cwd = taskBase;
    else {
      const moved = resolve(valid.task.project_cwd) === resolve(workspacePath) && resolve(taskBase) !== resolve(workspacePath)
        ? rerootTask({ ...valid.task, project_cwd: workspacePath }, relative(workspacePath, taskBase).split("\\").join("/")) : null;
      if (!moved) {
        const hint = resolve(taskBase) === resolve(workspacePath) ? `task.project_cwd must equal the configured writerWorkspacePath (${workspacePath})`
          : `task.project_cwd must equal ${taskBase}, the repository this task works in, or ${workspacePath} with every owned path, expected output and check inside that repository`;
        return { ok: false, error: { code: "validation_failed", retryable: false, sideEffects: "none", hint } };
      }
      valid.task = moved.task;
      canonicalPlan = planWithOutsideReads(canonicalPlan, moved.outsideReads);
    }
    const taskConfig = { ...runConfig, writerWorkspacePath: taskBase };

    // A task stored before the trusted tooling joined never_touch (P2-4) is compared as it would be stored now, so no change is invented.
    const changes = changedFields(applyTrustedTooling(oldContract), valid.task);
    if (canonicalPlan !== oldPlan) changes.push({ field: "plan", from: oldPlan, to: canonicalPlan });
    if (blocked) {
      const frozen = changes.map((change) => change.field).filter((field) => !IN_PLACE_FIELDS.includes(field));
      if (frozen.length) {
        return {
          ok: false,
          error: { code: "redispatch_required", retryable: false, sideEffects: "none",
            hint: `the task is blocked on its writer's question, so only ${IN_PLACE_FIELDS.join(", ")} change in place; ${frozen.join(", ")} need a redispatch: cancel the task and dispatch it again` },
        };
      }
      if (!changes.length) {
        return {
          ok: false,
          error: { code: "validation_failed", retryable: false, sideEffects: "none",
            hint: "the blocked task's contract and plan are unchanged: send the corrected fields, or answer the writer with lane_pilot_answer_writer" },
        };
      }
    }

    // The same contract lint as dispatch: every contract mistake goes back to the PM in one message, before the stored task changes.
    const linted = await lintTask(input.projectId, input.runId, valid.task, taskBase, config.hostId);
    // A blocked task keeps its area (a change needs a redispatch), so one dispatched before the task standard is not refused for lacking it.
    const lint = { ...linted, errors: blocked && !oldContract.area ? linted.errors.filter((error) => error.code !== "area_missing") : linted.errors };
    if (lint.errors.length) {
      const { runId: _runId, state: _state, reason: _reason, ...rest } = lintReply(input.runId, lint.errors);
      const hint = `contract lint: the task was not changed. Fix and send the update again:\n${lint.errors.map((error) => `- ${error.message}`).join("\n")}`;
      return { ok: false, error: { code: "validation_failed", retryable: false, sideEffects: "none", hint, ...rest } };
    }

    if (blocked) {
      const ready = await reopen.checkReopenable({ runId: input.runId, taskId: input.taskId, run, attempt: blocked });
      if (!ready.ok) return { ok: false, error: { code: "not_reopenable", retryable: false, sideEffects: "none", hint: ready.hint } };

      // Stored and written before the writer restarts, as for a queued task.
      updateTaskContract(db, input.taskId, valid.task);
      saveTaskPlan(db, input.taskId, canonicalPlan);
      await persistPlan(config.hostId, taskBase, input.taskId, canonicalPlan);
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
        await persistPlan(config.hostId, taskBase, input.taskId, oldPlan);
        return { ok: false, error: { code: "not_reopenable", retryable: false, sideEffects: "none", hint: reopened.hint } };
      }
      log(`writer ${input.taskId}: contract fixed in place (${changes.map((change) => change.field).join(", ")}); attempt ${blocked.id} continues`);
      return { ok: true, runId: input.runId, taskId: input.taskId, attemptId: blocked.id, writerThreadId: ready.threadId, state: "running",
        changed: changes.map((change) => change.field),
        note: "The writer continues in its own thread and worktree under the fixed contract; no attempt was spent. Poll lane_pilot_wait_writer with the same runId. The change is kept in the task folder's QA.md." };
    }

    // Save updated contract and plan in database
    updateTaskContract(db, input.taskId, valid.task);
    saveTaskPlan(db, input.taskId, canonicalPlan);

    // Persist PLAN.md to task folder
    await persistPlan(config.hostId, taskBase, input.taskId, canonicalPlan);

    // Rerun pmRead and plan critique
    const pmRead = await runPmRead({
      bb,
      db,
      projectId: input.projectId,
      runId: input.runId,
      taskId: input.taskId,
      pmThreadId: input.pmThreadId,
      config: taskConfig,
      task: valid.task,
    });

    const critique = await runPlanCritique({
      bb,
      db,
      projectId: input.projectId,
      runId: input.runId,
      taskId: input.taskId,
      config: taskConfig,
      task: valid.task,
      plan: canonicalPlan,
      pmReadContext: pmRead.summary || undefined,
    });

    for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
      recordStage(db, { runId: input.runId, taskId: input.taskId, stageId, state: "pending", input: canonicalPlan });
    }

    return {
      ok: true,
      runId: input.runId,
      taskId: input.taskId,
      state: "queued",
      stages: listStageReceipts(db, input.runId, input.taskId),
      critiqueAllowed: critique.allowed,
      ...(critique.reason ? { critiqueReason: critique.reason } : {}),
    };
  }

  return { updateTask };
}
