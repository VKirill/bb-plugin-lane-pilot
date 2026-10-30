import { statsEpochLine } from "../storage";
/** Task-level stability of live projects. One source for the daily summary and the wall.
 * Drill sandboxes are the two known project ids (stability/canary.ts `DRILL_SANDBOX_PROJECT_IDS`); named here so this file stays free of that room. */

const DRILL_PROJECT_IDS = new Set(["proj_3tb652jpsi", "proj_ibu6v9g64j"]);

const IN_FLIGHT = new Set(["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested", "canceled"]);

export type LiveAttempt = {
  taskId: string;
  projectId: string;
  projectName: string | null;
  state: string;
  reason: string | null;
  harnessVersion: string | null;
  updatedAt: number;
};

export type LiveStability = {
  tasks: number;
  accepted: number;
  lpErrors: number;
  taskFailures: number;
  other: number;
  excluded: { sandboxTasks: number; oldVersionTasks: number };
};

export function isLiveProject(projectId: string, projectName: string | null | undefined, taskId: string): boolean {
  if (DRILL_PROJECT_IDS.has(projectId)) return false;
  if (taskId.startsWith("drill-")) return false;
  const name = projectName ?? "";
  return !(name.startsWith("LP sandbox") || name.startsWith("LP native") || name.startsWith("LP bench"));
}

function triple(version: string | null): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version?.trim() ?? "");
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(version: string | null, floor: string): boolean {
  const left = triple(version);
  const right = triple(floor);
  if (!left || !right) return false;
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! > right[i]!;
  return true;
}

/** The reason after `retry limit N exhausted:`, which names the thing that was tried too often. */
function bare(reason: string | null): string {
  const text = reason ?? "";
  const at = text.indexOf("exhausted:");
  return (at >= 0 && text.startsWith("retry limit ") ? text.slice(at + "exhausted:".length) : text).trim().toLowerCase();
}

/** A red check, a path outside the task, or a check that does not test the task. An LP fault that only appears inside a verification line stays a task failure. */
function bucket(reason: string | null): "task" | "lp" | "other" {
  const text = bare(reason);
  if (/owns_paths|outside_scope|verification failed|verification timed out|empty_check/.test(text)) return "task";
  if (/owner_present|internal_error|reconcile|plugin reload|page_cap|attempt_worktree_|attempt_workspace_|critic broken/.test(text)) return "lp";
  return "other";
}

export function liveStability(rows: readonly LiveAttempt[], input: { floorVersion: string; epochMs?: number }): LiveStability {
  const byTask = new Map<string, LiveAttempt[]>();
  if (input.epochMs) rows = rows.filter((row) => row.updatedAt >= input.epochMs!);
  for (const row of rows) byTask.set(row.taskId, [...(byTask.get(row.taskId) ?? []), row]);
  const report: LiveStability = { tasks: 0, accepted: 0, lpErrors: 0, taskFailures: 0, other: 0, excluded: { sandboxTasks: 0, oldVersionTasks: 0 } };
  for (const attempts of byTask.values()) {
    const sample = attempts[0]!;
    if (attempts.some((row) => !isLiveProject(row.projectId, row.projectName, row.taskId)) || !isLiveProject(sample.projectId, sample.projectName, sample.taskId)) {
      report.excluded.sandboxTasks++;
      continue;
    }
    if (!attempts.some((row) => atLeast(row.harnessVersion, input.floorVersion))) {
      report.excluded.oldVersionTasks++;
      continue;
    }
    const judged = attempts.filter((row) => atLeast(row.harnessVersion, input.floorVersion) && !IN_FLIGHT.has(row.state));
    if (!judged.length) continue;
    report.tasks++;
    if (judged.some((row) => row.state === "accepted")) { report.accepted++; continue; }
    const latest = judged.reduce((best, row) => row.updatedAt >= best.updatedAt ? row : best);
    const kind = bucket(latest.reason);
    if (kind === "lp") report.lpErrors++;
    else if (kind === "task") report.taskFailures++;
    else report.other++;
  }
  return report;
}

export function renderLiveStability(report: LiveStability, epochMs?: number): string {
  const pct = report.tasks ? (100 * report.accepted / report.tasks).toFixed(1) : "0.0";
  return `${epochMs ? `${statsEpochLine(epochMs)}. ` : ""}Живые проекты, по задачам: ${report.tasks} задач, принято ${report.accepted} (${pct}%). Ошибка LP: ${report.lpErrors}. Провал задачи: ${report.taskFailures}. Прочее: ${report.other}. Вне счёта: песочницы ${report.excluded.sandboxTasks}, старые версии ${report.excluded.oldVersionTasks}.`;
}
