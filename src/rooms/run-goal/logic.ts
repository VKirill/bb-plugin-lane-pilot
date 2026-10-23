/**
 * The run-goal check (SMA atlas D2-3). Each task of a run was accepted on its own checks; together they can still break each other (two
 * tasks green alone, red on the same main). When a run is done, every accepted task's checks run again on the final main, all together:
 * the regression pass of the baseline room does the running, the bisect and the finding; this room decides when and what it means.
 */
export type TaskState = { taskId: string; state: string };
export type RedCheck = { taskId: string; command: string; culpritCommit: string | null; culpritTask: string | null };
/**
 * A red check that is not the run's composition: work outside the run broke it, a later task of the run rewrote what it checks, or it is
 * red at its own merge commit as well (the regression pass's «unstable»: the pass's worktree or a flaky check, not anything merged later).
 */
export type AsideCheck = RedCheck & { why: "outside" | "rewritten" | "unstable" };
export type GoalVerdict = { state: "passed" | "failed" | "skipped"; red: RedCheck[]; detail: string | null; aside?: AsideCheck[] };

/** Terminal states a task can end a run in: accepted or given up. Any other latest state means the run is not done. */
const DONE = new Set(["accepted", "canceled"]);
export const MIN_ACCEPTED = 2;

/** A run is ready for the check when every task's latest attempt is accepted or canceled and at least two are accepted. */
export function runReady(tasks: readonly TaskState[]): boolean {
  return tasks.length > 0 && tasks.every((task) => DONE.has(task.state)) && tasks.filter((task) => task.state === "accepted").length >= MIN_ACCEPTED;
}

/**
 * Whether a red check is the run's own composition. The pass runs on the project's current main, which can be days past the run, and bisect
 * names the first bad commit: a commit that is no task of this run (a later run, the owner's PR, a docs refresh) is not this run's break; a
 * later task of the run that changed a file the check command itself names (the version a release check pins, the test file a revert
 * rewrote) changed that check's contract on purpose. Both stay open in the regression list (`bb lane-pilot regress`); only the rest fails
 * the goal. A red check with no culprit counts, since nothing says whose it is, unless it is red at its own merge commit too.
 */
function asideReason(row: RedCheck, runTasks: ReadonlySet<string> | null, sharedFiles: readonly string[], kind: string | undefined): AsideCheck["why"] | null {
  // Red at the task's own merge commit too: the same check on the same tree the task was accepted with fails in the pass's worktree, so no
  // composition broke it (lprun_6163b96a: `tsc` of a nested package with no node_modules in the throwaway worktree, 2026-10-23).
  if (kind === "unstable") return "unstable";
  if (!runTasks || !row.culpritCommit) return null;
  if (!row.culpritTask || !runTasks.has(row.culpritTask)) return "outside";
  if (row.culpritTask !== row.taskId && sharedFiles.some((path) => names(row.command, path))) return "rewritten";
  return null;
}

/** The command names the file: the path appears whole (`./package.json`, `src/a.test.ts`), not as part of a longer name (`src/a.ts` in `src/a.tsx`). */
function names(command: string, path: string): boolean {
  if (!path) return false;
  for (let at = command.indexOf(path); at >= 0; at = command.indexOf(path, at + 1)) {
    const before = command[at - 1] ?? " ";
    const after = command[at + path.length] ?? " ";
    if (!/[\w.-]/.test(after) && !/[\w-]/.test(before)) return true;
  }
  return false;
}

/** The verdict from what the regression pass reported for the run's tasks; `runTasks` (the run's task ids) sets aside reds that are not its composition. */
export function goalVerdict(pass: { skipped?: string | undefined; tasks: ReadonlyArray<{ taskId: string; checks: ReadonlyArray<{ command: string; state: string }>; skipped?: string | undefined }>;
  findings: ReadonlyArray<{ taskId: string; command: string; culpritCommit: string | null; culpritTask: string | null; sharedFiles?: readonly string[] | undefined; kind?: string | undefined }> }, runTasks?: readonly string[]): GoalVerdict {
  const ran = pass.tasks.filter((task) => !task.skipped && task.checks.some((check) => check.state === "green" || check.state === "red"));
  if (pass.skipped || !ran.length) return { state: "skipped", red: [], detail: pass.skipped ?? "no task of the run had a check to run on main" };
  const ids = runTasks ? new Set(runTasks) : null;
  const red: RedCheck[] = [];
  const aside: AsideCheck[] = [];
  for (const task of ran) {
    for (const check of task.checks.filter((entry) => entry.state === "red")) {
      const finding = pass.findings.find((row) => row.taskId === task.taskId && row.command === check.command);
      const row: RedCheck = { taskId: task.taskId, command: check.command, culpritCommit: finding?.culpritCommit ?? null, culpritTask: finding?.culpritTask ?? null };
      const why = asideReason(row, ids, finding?.sharedFiles ?? [], finding?.kind);
      if (why) aside.push({ ...row, why }); else red.push(row);
    }
  }
  if (!aside.length) return { state: red.length ? "failed" : "passed", red, detail: null };
  const outside = aside.filter((row) => row.why === "outside");
  const rewritten = aside.filter((row) => row.why === "rewritten");
  const unstable = aside.filter((row) => row.why === "unstable");
  const detail = [
    outside.length ? `${outside.length} red by work outside the run (${outside.slice(0, 4).map((row) => `${row.taskId} by ${row.culpritCommit!.slice(0, 10)}`).join(", ")}${outside.length > 4 ? ", ..." : ""})` : null,
    rewritten.length ? `${rewritten.length} rewritten on purpose by a later task of the run (${rewritten.slice(0, 4).map((row) => `${row.taskId} by ${row.culpritTask}`).join(", ")}${rewritten.length > 4 ? ", ..." : ""})` : null,
    unstable.length ? `${unstable.length} red at their own merge commit as well, the pass's worktree or a flaky check (${unstable.slice(0, 4).map((row) => row.taskId).join(", ")}${unstable.length > 4 ? ", ..." : ""})` : null,
  ].filter(Boolean).join("; ") + ": open in bb lane-pilot regress";
  return { state: red.length ? "failed" : "passed", red, detail: detail.slice(0, 500), aside };
}

/** The PM's message for a failed run goal: which checks went red together and which commit bisect named. */
export function pmGoalMessage(runId: string, red: readonly RedCheck[]): string {
  const lines = red.slice(0, 8).map((row) => `- ${row.taskId}: ${row.command}${row.culpritCommit ? ` (сломал ${row.culpritCommit.slice(0, 10)}${row.culpritTask ? `, задача ${row.culpritTask}` : ""})` : ""}`);
  return [`Lane Pilot: задачи запуска ${runId} приняты каждая по отдельности, но вместе на итоговом main ${red.length} проверок красные:`, ...lines,
    "Поставьте задачу на починку стыка (owns_paths — файлы виновного коммита) или верните задачу на стадию (bb lane-pilot return)."].join("\n");
}
