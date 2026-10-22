/**
 * The run-goal check (SMA atlas D2-3). Each task of a run was accepted on its own checks; together they can still break each other (two
 * tasks green alone, red on the same main). When a run is done, every accepted task's checks run again on the final main, all together:
 * the regression pass of the baseline room does the running, the bisect and the finding; this room decides when and what it means.
 */
export type TaskState = { taskId: string; state: string };
export type RedCheck = { taskId: string; command: string; culpritCommit: string | null; culpritTask: string | null };
export type GoalVerdict = { state: "passed" | "failed" | "skipped"; red: RedCheck[]; detail: string | null };

/** Terminal states a task can end a run in: accepted or given up. Any other latest state means the run is not done. */
const DONE = new Set(["accepted", "canceled"]);
export const MIN_ACCEPTED = 2;

/** A run is ready for the check when every task's latest attempt is accepted or canceled and at least two are accepted. */
export function runReady(tasks: readonly TaskState[]): boolean {
  return tasks.length > 0 && tasks.every((task) => DONE.has(task.state)) && tasks.filter((task) => task.state === "accepted").length >= MIN_ACCEPTED;
}

/** The verdict from what the regression pass reported for the run's tasks. */
export function goalVerdict(pass: { skipped?: string | undefined; tasks: ReadonlyArray<{ taskId: string; checks: ReadonlyArray<{ command: string; state: string }>; skipped?: string | undefined }>;
  findings: ReadonlyArray<{ taskId: string; command: string; culpritCommit: string | null; culpritTask: string | null }> }): GoalVerdict {
  const ran = pass.tasks.filter((task) => !task.skipped && task.checks.some((check) => check.state === "green" || check.state === "red"));
  if (pass.skipped || !ran.length) return { state: "skipped", red: [], detail: pass.skipped ?? "no task of the run had a check to run on main" };
  const red = ran.flatMap((task) => task.checks.filter((check) => check.state === "red").map((check): RedCheck => {
    const finding = pass.findings.find((row) => row.taskId === task.taskId && row.command === check.command);
    return { taskId: task.taskId, command: check.command, culpritCommit: finding?.culpritCommit ?? null, culpritTask: finding?.culpritTask ?? null };
  }));
  return { state: red.length ? "failed" : "passed", red, detail: null };
}

/** The PM's message for a failed run goal: which checks went red together and which commit bisect named. */
export function pmGoalMessage(runId: string, red: readonly RedCheck[]): string {
  const lines = red.slice(0, 8).map((row) => `- ${row.taskId}: ${row.command}${row.culpritCommit ? ` (сломал ${row.culpritCommit.slice(0, 10)}${row.culpritTask ? `, задача ${row.culpritTask}` : ""})` : ""}`);
  return [`Lane Pilot: задачи запуска ${runId} приняты каждая по отдельности, но вместе на итоговом main ${red.length} проверок красные:`, ...lines,
    "Поставьте задачу на починку стыка (owns_paths — файлы виновного коммита) или верните задачу на стадию (bb lane-pilot return)."].join("\n");
}
