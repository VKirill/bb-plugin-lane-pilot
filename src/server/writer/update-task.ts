import { resolve } from "node:path";
import { DISPATCH_STAGES_PENDING } from "../../constants";
import { taskV2Schema } from "../../contracts";
import type { TaskV2 } from "../../contracts";
import {
  countAttempts,
  getAttempt,
  getRun,
  getRunSettingsScopes,
  getTask,
  getTaskPlan,
  listAttemptsForTask,
  listStageReceipts,
  loadProjectSettings,
  loadPrototypeConfig,
  saveTaskPlan,
  updateTaskContract,
} from "../../database";
import { findSandboxUnsafeMissingExcludes, parseSandboxUnsafePatterns } from "../../stages/critique-coverage";
import { runPlanCritique, runPmRead } from "../critique-runs";
import { recordStage } from "../stage-records";
import type { ServerCore } from "../core";
import type { Services } from "../services";
import { validateTaskV2 } from "../../task-v2";
import { appendExcludeCommand, persistTaskFolder } from "../../verification/git-integrate";
import { validateOwnershipContract } from "../../verification/ownership";
import { parseReadFirstHints, readFirstKindError } from "../../stages/read-first";

export function createWriterUpdateTask(ctx: ServerCore, services: Services) {
  const { bb, db, host } = ctx;

  async function updateTask(input: {
    projectId: string;
    runId: string;
    pmThreadId: string;
    taskId: string;
    task?: TaskV2;
    plan?: string;
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

    const attempt = getAttempt(db, latestAttempt.id);
    if (attempt?.reason === DISPATCH_STAGES_PENDING) {
      return {
        ok: false,
        error: { code: "dispatch_in_progress", retryable: true, sideEffects: "none", hint: "The task's pm-read and plan critique are still running; update it once they finish." },
      };
    }
    if (attempt?.thread_id || attempt?.state !== "queued") {
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

    const config = await loadPrototypeConfig(db, input.projectId);
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
    const canonicalPlan = input.plan ?? (input.task ? updatedContract.objective : oldPlan);

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
    if (resolve(valid.task.project_cwd) !== resolve(workspacePath)) {
      return {
        ok: false,
        error: { code: "validation_failed", retryable: false, sideEffects: "none", hint: `task.project_cwd must equal the configured writerWorkspacePath (${workspacePath})` },
      };
    }
    valid.task.project_cwd = workspacePath;

    // Reject sandbox-unsafe checks if present
    const settings = loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId));
    const sandboxUnsafePatterns = parseSandboxUnsafePatterns(settings["verification.sandbox_unsafe"]);
    if (sandboxUnsafePatterns.length) {
      for (const v of valid.task.verification ?? []) {
        const missing = findSandboxUnsafeMissingExcludes(v.command, sandboxUnsafePatterns);
        if (missing.length) {
          const excludeFlags = missing.map((pat) => `--exclude "${pat}"`).join(" ");
          return {
            ok: false,
            error: {
              code: "validation_failed",
              retryable: false,
              sideEffects: "none",
              hint: `verification command "${v.command}" runs a full test suite without excluding sandbox-unsafe tests; add missing exclusions: ${excludeFlags}`,
              missingExcludes: missing,
              suggestedFlags: excludeFlags,
            },
          };
        }
      }
    }

    let readFirstHints: ReturnType<typeof parseReadFirstHints>;
    try {
      readFirstHints = parseReadFirstHints(valid.task.read_first);
    } catch (cause) {
      return {
        ok: false,
        error: { code: "validation_failed", retryable: false, sideEffects: "none", hint: cause instanceof Error ? cause.message : String(cause) },
      };
    }
    if (readFirstHints.length) {
      try {
        const snapshot = await host.call("snapshotDryRun", {
          requestedHostId: config.hostId,
          paths: readFirstHints.map((hint) => resolve(workspacePath, hint.path)),
        }, { hostId: config.hostId, timeoutMs: 30_000 });
        for (const hint of readFirstHints) {
          const entry = snapshot.entries.find((r) => r.path === resolve(workspacePath, hint.path));
          if (entry?.kind === "directory") {
            const kindError = readFirstKindError(hint.path, "directory");
            if (kindError) return { ok: false, error: { code: "validation_failed", retryable: false, sideEffects: "none", hint: kindError } };
          }
          if (entry?.kind === "symlink" || entry?.kind === "other") {
            return { ok: false, error: { code: "validation_failed", retryable: false, sideEffects: "none", hint: `read_first is not a regular file (${entry.kind}): ${hint.path}` } };
          }
        }
      } catch {}
    }

    const ownershipError = validateOwnershipContract(valid.task);
    if (ownershipError) {
      return {
        ok: false,
        error: { code: "validation_failed", retryable: false, sideEffects: "none", hint: ownershipError },
      };
    }

    // Save updated contract and plan in database
    updateTaskContract(db, input.taskId, valid.task);
    saveTaskPlan(db, input.taskId, canonicalPlan);

    // Persist PLAN.md to task folder
    try {
      await persistTaskFolder({
        taskId: input.taskId,
        plan: canonicalPlan,
        exclude: async (line) => {
          const ran = await host.call("runCommand", {
            requestedHostId: config.hostId,
            cwd: workspacePath,
            command: appendExcludeCommand(line),
            timeoutSec: 30,
          }, { hostId: config.hostId, timeoutMs: 30_000 });
          if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `git exited ${ran.exitCode}`);
        },
        writeFile: async (rel, content) => {
          await bb.sdk.files.write({
            hostId: config.hostId,
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
      bb.log.warn(`Lane Pilot could not persist task folder for ${input.taskId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }

    // Rerun pmRead and plan critique
    const pmRead = await runPmRead({
      bb,
      db,
      projectId: input.projectId,
      runId: input.runId,
      taskId: input.taskId,
      pmThreadId: input.pmThreadId,
      config: runConfig,
      task: valid.task,
    });

    const critique = await runPlanCritique({
      bb,
      db,
      projectId: input.projectId,
      runId: input.runId,
      taskId: input.taskId,
      config: runConfig,
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
