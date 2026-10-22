import type { TaskV2 } from "../contracts";

/**
 * The decisions of the baseline and the regression pass, without any I/O: settings, which checks are cheap enough, what the baseline
 * says about a task, which checks turned red, who a commit belongs to. The server files only run things and write rows.
 */

export type VerificationItem = TaskV2["verification"][number];

// ---- settings (project settings, read leniently: a bad value is the default, never a stopped task) ----

export type BaselineSettings = {
  /** notify: the PM and the acceptance card see «already built», the attempt goes on. stop: the attempt does not start. */
  mode: "notify" | "stop";
  /** The time the baseline may spend on a start, in seconds, as a sum of the checks' estimates. 0 turns the baseline off. */
  timeCapSec: number;
  /** `checks.require_red_on_base`: from which risk a task needs at least one check that is red on the base (off: never). */
  requireRed: RequireRed;
};

export type RequireRed = "off" | "medium" | "high";
export const BASELINE_DEFAULTS: BaselineSettings = { mode: "notify", timeCapSec: 300, requireRed: "medium" };

const number = (value: unknown): number | null => {
  const parsed = typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
};
const bounded = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = number(value);
  return parsed === null ? fallback : Math.min(max, Math.max(min, parsed));
};

export function parseBaselineSettings(values: Record<string, unknown>): BaselineSettings {
  const mode = values["baseline.already_built"];
  return {
    mode: mode === "stop" ? "stop" : "notify",
    timeCapSec: number(values["baseline.time_cap_sec"]) === 0 ? 0 : bounded(values["baseline.time_cap_sec"], BASELINE_DEFAULTS.timeCapSec, 10, 3600),
    requireRed: values["checks.require_red_on_base"] === "off" || values["checks.require_red_on_base"] === "high" ? values["checks.require_red_on_base"] : "medium",
  };
}

// ---- red before green: a check that is green on the base proves nothing about the work ----

/** Kinds of work that add no behaviour to test for (a refactor keeps the checks green, a docs or research task has nothing to run red). */
export const NO_RED_KINDS: readonly string[] = ["refactor", "docs", "research", "check"];

const RISK_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Whether a task of this risk and kind must have a check that is red on the base before its attempt may start. */
export function requiresRedOnBase(setting: RequireRed, task: { risk: string; kind?: string | undefined }): boolean {
  if (setting === "off") return false;
  if (task.kind && NO_RED_KINDS.includes(task.kind)) return false;
  return (RISK_RANK[task.risk] ?? 0) >= (setting === "high" ? 2 : 1);
}

/** The checks that cannot fail the work: when every check ran green on the base and none is red, they all are. Otherwise nothing is claimed. */
export function vacuousChecks(checks: readonly BaselineCheck[]): BaselineCheck[] {
  return checks.length > 0 && checks.every((check) => check.status === "green") ? [...checks] : [];
}

/** What the PM reads when the attempt does not start because no check is red on the base: which checks are vacuous and what to add. */
export function vacuousMessage(taskId: string, vacuous: readonly BaselineCheck[], risk: string, baseSha: string | null): string {
  const list = vacuous.map((check) => `- ${check.command}`).join("\n");
  return `все ${vacuous.length} проверок(и) задачи ${taskId} (риск ${risk}) уже проходят на базе${baseSha ? ` ${baseSha.slice(0, 10)}` : ""}, до писателя:\n${list}\n`
    + `Такие проверки зелёные при любой работе писателя, поэтому не доказывают её. Добавьте хотя бы одну, которая сейчас красная и позеленеет только когда работа сделана: `
    + `проверку, называющую новый файл или поведение (test -f <новый файл>; grep -q '<новый символ>' <файл>; точечный тест, который падает сейчас), и отправьте задачу снова. `
    + `Если у работы нельзя написать красную проверку (чистый рефакторинг, документация), укажите kind refactor или docs.`;
}

export type RegressSettings = {
  nightly: boolean;
  /** The last N accepted tasks of a project, and no task accepted longer ago than `days`. */
  lastN: number;
  days: number;
  /** A check whose estimate is above this is not cheap and is left out. */
  checkCapSec: number;
  /** The time one project's pass may spend running checks and bisecting. */
  budgetSec: number;
  /** A bisect over more than 2^steps commits is not started. */
  bisectSteps: number;
};

export const REGRESS_DEFAULTS: RegressSettings = { nightly: true, lastN: 30, days: 14, checkCapSec: 120, budgetSec: 1800, bisectSteps: 9 };

export function parseRegressSettings(values: Record<string, unknown>): RegressSettings {
  const nightly = values["regress.nightly"];
  return {
    nightly: !(nightly === "off" || nightly === false || nightly === "false"),
    lastN: bounded(values["regress.last_n"], REGRESS_DEFAULTS.lastN, 1, 200),
    days: bounded(values["regress.last_days"], REGRESS_DEFAULTS.days, 1, 365),
    checkCapSec: bounded(values["regress.check_cap_sec"], REGRESS_DEFAULTS.checkCapSec, 5, 1800),
    budgetSec: bounded(values["regress.budget_sec"], REGRESS_DEFAULTS.budgetSec, 60, 14_400),
    bisectSteps: bounded(values["regress.bisect_steps"], REGRESS_DEFAULTS.bisectSteps, 1, 14),
  };
}

// ---- which checks are cheap ----

/** Nearest-rank 95th percentile; 0 for no values. */
export function p95(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

/** The estimate for a check with no history: it may be slow, but a pass cannot know; its run is cut by the cap anyway. */
export const NOMINAL_CHECK_SEC = 30;

/** Seconds a check is expected to take: the p95 of its last green runs when there are three or more, else a nominal 30 s (or its configured limit when lower). */
export function estimateSec(durationsMs: readonly number[], configuredSec: number): number {
  return durationsMs.length >= 3 ? Math.max(1, Math.ceil(p95(durationsMs) / 1000)) : Math.min(configuredSec, NOMINAL_CHECK_SEC);
}

export type PlannedCheck = { item: VerificationItem; estimateSec: number; skip: string | null };

/**
 * The checks that fit a budget, in the order the contract lists them. A check with secrets never runs here (a baseline or a nightly
 * pass has no business holding them); one over `perCheckCapSec` is slow; the rest are taken while their estimates add up to the cap.
 * `free` names the commands whose answer is already known (cached): they cost nothing.
 */
export function planChecks(
  items: readonly VerificationItem[], estimateOf: (item: VerificationItem) => number, input: { totalCapSec: number; perCheckCapSec: number; free?: (item: VerificationItem) => boolean },
): PlannedCheck[] {
  let spent = 0;
  return items.map((item) => {
    const estimate = estimateOf(item);
    if ((item.secrets?.length ?? 0) > 0) return { item, estimateSec: estimate, skip: "the check carries secrets" };
    if (input.free?.(item)) return { item, estimateSec: 0, skip: null };
    if (estimate > input.perCheckCapSec) return { item, estimateSec: estimate, skip: `too slow for this pass (about ${estimate}s, cap ${input.perCheckCapSec}s)` };
    if (spent + estimate > input.totalCapSec) return { item, estimateSec: estimate, skip: `over the time cap (${input.totalCapSec}s)` };
    spent += estimate;
    return { item, estimateSec: estimate, skip: null };
  });
}

// ---- the baseline ----

export type BaselineCheck = {
  command: string;
  cwd: string;
  status: "green" | "red" | "skipped" | "unknown";
  exitCode: number | null;
  /** Why it was skipped, or the end of the output of a red one. */
  note: string;
  /** Answered from an earlier baseline on the same base. */
  cached?: true;
  durationMs?: number;
};

export type BaselineVerdict = "already_built" | "partial" | "red" | "unknown";

/** already_built only when every check ran and passed; a skipped or unknown check keeps the claim back. */
export function baselineVerdict(checks: readonly BaselineCheck[]): BaselineVerdict {
  if (!checks.length) return "unknown";
  if (checks.every((check) => check.status === "green")) return "already_built";
  const ran = checks.filter((check) => check.status === "green" || check.status === "red");
  if (!ran.length) return "unknown";
  return ran.every((check) => check.status === "red") && ran.length === checks.length ? "red" : "partial";
}

/** Checks that were green on the base and are red after the change. A check the host could not run says nothing. */
export function turnedRed(baseline: readonly BaselineCheck[], after: ReadonlyArray<{ command: string; exitCode: number; hostError?: true | undefined }>): string[] {
  const green = new Set(baseline.filter((check) => check.status === "green").map((check) => check.command));
  return after.filter((check) => check.exitCode !== 0 && !check.hostError && green.has(check.command)).map((check) => check.command);
}

export function baselineSummary(verdict: BaselineVerdict, checks: readonly BaselineCheck[], baseSha: string | null): string {
  const count = (status: BaselineCheck["status"]) => checks.filter((check) => check.status === status).length;
  const at = baseSha ? ` on base ${baseSha.slice(0, 10)}` : "";
  if (verdict === "already_built") return `all ${checks.length} check(s) already pass${at}: the task may be already done`;
  return `${count("green")} green, ${count("red")} red, ${count("skipped")} skipped, ${count("unknown")} unknown of ${checks.length} check(s)${at}`;
}

// ---- the regression pass ----

/** One word for the shell: quoted so that nothing in it is read by the shell. */
export const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * The command `git bisect run` calls on every commit it tries: the check in its folder, exit 0 when green and 1 when red. Git reads 125 as
 * «cannot test, skip» and anything above 127 as «abort», which a check's own exit code must not be mistaken for.
 */
export function bisectCommand(relativeCwd: string, command: string): string {
  const folder = relativeCwd && relativeCwd !== "." ? `cd ${shellQuote(relativeCwd)} || exit 125; ` : "";
  return `${folder}CI=1 /bin/bash -c ${shellQuote(command)}; code=$?; if [ $code -eq 0 ]; then exit 0; else exit 1; fi`;
}

const ATTEMPT_TRAILER = /^Lane-Pilot-Attempt:\s*(\S+)\s*$/m;
const SUBJECT_TASK = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127}): /;

/** The attempt a commit message names by its trailer, or the task its subject starts with. */
export function messageOwner(message: string): { attemptId: string | null; taskId: string | null } {
  return { attemptId: ATTEMPT_TRAILER.exec(message)?.[1] ?? null, taskId: SUBJECT_TASK.exec(message.split("\n")[0] ?? "")?.[1] ?? null };
}

/** How many bisect steps a range of commits needs. */
export const bisectStepsFor = (commits: number): number => (commits <= 1 ? 0 : Math.ceil(Math.log2(commits)));
