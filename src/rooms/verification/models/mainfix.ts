import type { TaskV2 } from "../../contracts";

export type RedCheckInput = {
  command: string;
  exitCode: number;
  stdout?: string;
  stderr?: string;
  hostError?: boolean;
  threw?: boolean;
  rerun?: { exitCode: number; stdout?: string; stderr?: string; hostError?: boolean; threw?: boolean };
};

const tail = (check: RedCheckInput, size = 600) => `${check.stderr ?? ""}\n${check.stdout ?? ""}`.trim().slice(-size);
const logName = (command: string, index: number) =>
  `${String(index + 1).padStart(2, "0")}-${command.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "check"}.log`;

/**
 * The ONE `-mainfix` repair task builder shared across post-merge checks, integration gates, and the unified landing step.
 */
export function buildMainfixTask(
  onMain: TaskV2,
  red: Array<{ command: string; exitCode: number; stdout?: string; stderr?: string }>,
  options: { objectiveOverride?: string; planOverride?: string } = {},
): { fix: TaskV2; plan: string; logs: Array<{ path: string; content: string }> } {
  const fix: TaskV2 = {
    ...onMain,
    id: `${onMain.id}-mainfix`.slice(0, 128),
    title: `Make main green after ${onMain.id}`.slice(0, 200),
    display_title: `Починка main после ${onMain.id}`.slice(0, 60),
    kind: "fix",
    area: onMain.area ?? "maintenance",
    depends_on: [],
    risk: onMain.risk === "low" ? "medium" : onMain.risk,
    expected_outputs: red.map((check) => check.command),
    objective: options.objectiveOverride ?? (
      `Main is red after merging ${onMain.id} (${onMain.title}): these checks fail on main while they passed in the task's own worktree, so the merged work clashes with what landed meanwhile. Make each of them pass on main, keeping what ${onMain.id} and the work merged before it intended; change the least code that does it. Failing now:\n` +
      red.map((check) => `\`${check.command}\` (exit ${check.exitCode}) output tail:\n${tail(check)}`).join("\n\n")
    ),
    acceptance: [
      ...red.map((check) => `\`${check.command}\` passes on main`),
      ...(onMain.acceptance ?? []).map((item) => `${onMain.id}'s acceptance still holds: ${item}`),
    ],
  };
  const logs = red.map((check, index) => ({
    path: `.agents/plans/items/${fix.id}/logs/${logName(check.command, index)}`,
    content: `$ ${check.command}\nexit ${check.exitCode}\n\n${check.stdout ?? ""}\n${check.stderr ?? ""}`.trim() + "\n",
  }));
  const plan = options.planOverride ??
    `Post-merge repair, dispatched by Lane Pilot. Full output of every failing check: ${logs.map((log) => log.path).join(", ")}.\n\nRead the failure, find which merged change clashes (git log -5 on main), fix within owns_paths, run the checks. If every check already passes in your worktree before you change anything, main is green now: change no files and answer with the first line \`NEEDS_HUMAN: main is already green, nothing to fix\`.`;
  return { fix, plan, logs };
}
