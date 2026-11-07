import { z } from "zod";
import { callerPluginMetadata, registerObservedTool, type Services } from "../../platform/server";
import { ToolError, type ServerCore } from "../../contracts/server";
import { getTask, listOpenAttempts, taskBasePath } from "../../storage";
import { ownsPathsOverlap } from "@lane-pilot/kit";
import { quarantineFileSet } from "../regress-files";
import { getRegression, listRegressions, type RegressionRecord } from "../store";

/**
 * The PM's view of the regression findings (`lane_pilot_regression`, folded): the open rows of its project — which check
 * is red, which task the bisect blamed, which files quarantine other tasks and which tasks wait right now — and `settle`
 * for a row the culprit changed on purpose. Settle runs the same close as `bb lane-pilot regress-close`, so a hand-settled
 * row stays closed while the check stays red (store.ts `settledByHand`). Born of SelfyStudio 2026-11-02: a PM saw
 * «quarantine: open regression … shares files» and told the owner it could not be lifted.
 */

const REASON_MIN = 15;

const changedFilesOf = (services: Services) => (taskId: string): string[] =>
  (services.rollback?.status(taskId).attempts ?? [])
    .filter((attempt) => attempt.state === "accepted")
    .flatMap((attempt) => attempt.change?.changed.map((file) => file.path) ?? []);

const shorten = (command: string): string => (command.length > 160 ? `${command.slice(0, 157)}…` : command);

/** Task ids with an open attempt that the row quarantines right now (same checkout, overlapping owns_paths). */
function waitingTasks(ctx: ServerCore, services: Services, row: RegressionRecord): string[] {
  if (row.kind !== "regression" || row.bisectStatus !== "found") return [];
  const { db } = ctx;
  const files = quarantineFileSet(row, changedFilesOf(services));
  const base = taskBasePath(db, row.runId, row.taskId);
  const waiting = new Set<string>();
  for (const attempt of listOpenAttempts(db)) {
    if (attempt.project_id !== row.projectId || attempt.task_id === row.taskId || waiting.has(attempt.task_id)) continue;
    if (base && taskBasePath(db, attempt.run_id, attempt.task_id) !== base) continue;
    const contract = getTask(db, attempt.task_id)?.contract as { owns_paths?: unknown; fixes_regressions?: unknown } | undefined;
    // A task that names this row in fixes_regressions is the fix, not a waiter.
    const fixes = Array.isArray(contract?.fixes_regressions) ? (contract!.fixes_regressions as unknown[]).filter((x): x is number => typeof x === "number") : [];
    if (fixes.includes(row.id)) continue;
    const owns = Array.isArray(contract?.owns_paths) ? (contract!.owns_paths as unknown[]).filter((x): x is string => typeof x === "string") : [];
    if (ownsPathsOverlap(owns, files)) waiting.add(attempt.task_id);
  }
  return [...waiting].sort();
}

function rowView(ctx: ServerCore, services: Services, row: RegressionRecord) {
  const evidence = (row.evidence ?? {}) as { sharedFiles?: unknown };
  return {
    id: row.id,
    task: row.taskId,
    check: shorten(row.command),
    culprit_task: row.culpritTask,
    shared_files: Array.isArray(evidence.sharedFiles) ? evidence.sharedFiles : [],
    note: row.note,
    found_at: new Date(row.foundAt).toISOString(),
    waiting: waitingTasks(ctx, services, row),
  };
}

export function mountRegressionTools(ctx: ServerCore, services: Services): void {
  const { db } = ctx;

  registerObservedTool(ctx.bb.agents, {
    name: "lane_pilot_regression_list",
    description: "The open regression findings of this project: which accepted task's check went red on main, which task the bisect blamed, and which tasks wait on the row right now.",
    instructions: "Use only from the active Lane Pilot PM thread, when a task waits on a quarantine or you want the state of the nightly regression watch. Each row names the check, the culprit task, the shared files and the task ids it holds back. A row whose culprit changed those files on purpose is settled with lane_pilot_regression {action:\"settle\"}; a real break is fixed by a task that owns the shared files and names the row's id in its fixes_regressions, so the row does not hold it.",
    parameters: z.object({}).strict(),
    execute: async (_params, context) => {
      const rows = listRegressions(db, { projectId: context.projectId });
      return JSON.stringify({ open: rows.map((row) => rowView(ctx, services, row)) }, null, 2);
    },
  });

  registerObservedTool(ctx.bb.agents, {
    name: "lane_pilot_regression_settle",
    description: "Settle an open regression finding of this project: the check is red because the culprit task changed what it pins on purpose.",
    instructions: "Use only from the active Lane Pilot PM thread, for a row of lane_pilot_regression {action:\"list\"} whose culprit changed the shared files on purpose — a real break is fixed by a task that owns them, not settled. id is the row id; reason (15+ characters) says why the change was meant, it is kept on the closed row. The tasks the row held back start by themselves.",
    parameters: z.object({ id: z.number().int().min(1), reason: z.string().trim().min(REASON_MIN).max(400) }).strict(),
    execute: async (params, context) => {
      const metadata = await callerPluginMetadata(ctx.bb, context);
      if ((metadata as Record<string, unknown> | null)?.role !== "pm") {
        throw new ToolError("caller is not a Lane Pilot PM thread", { code: "not_pm_thread", retryable: false, sideEffects: "none" });
      }
      const row = getRegression(db, params.id);
      if (!row) {
        throw new ToolError(`no regression ${params.id}: list the open rows of your project with lane_pilot_regression {action:"list"}`, { code: "no_such_regression", retryable: false, sideEffects: "none", next: "lane_pilot_regression {action:\"list\"}" });
      }
      if (row.projectId !== context.projectId) {
        throw new ToolError(`regression ${params.id} belongs to another project: list the open rows of this one with lane_pilot_regression {action:"list"}`, { code: "wrong_project", retryable: false, sideEffects: "none", next: "lane_pilot_regression {action:\"list\"}" });
      }
      if (row.state !== "open") {
        throw new ToolError(`regression ${params.id} is closed already (${row.closedReason ?? "no reason"})`, { code: "already_closed", retryable: false, sideEffects: "none", next: "lane_pilot_regression {action:\"list\"}" });
      }
      const reason = `settled by PM ${context.threadId}: ${params.reason}`;
      const closed = services.regression.close(params.id, reason);
      if (!closed.ok) {
        throw new ToolError(`regression ${params.id} could not be settled: ${closed.reason}`, { code: "settle_failed", retryable: false, sideEffects: "none" });
      }
      return JSON.stringify({ ok: true, id: params.id, closed_reason: reason });
    },
  });
}
