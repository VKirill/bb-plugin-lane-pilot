import { posix } from "node:path";
import { fileAllowedByOwns } from "@lane-pilot/kit";
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
  // A fix has a failure to show, so its risk does not excuse it: five low-risk vf-fix-b1-* of Vampirism Fire (2026-10-26) were accepted on a
  // check.sh that was green on the base, and the first batch run on main found 39 failures. Only the owner's «high» raises the bar above it.
  if (task.kind === "fix" && setting === "medium") return true;
  return (RISK_RANK[task.risk] ?? 0) >= (setting === "high" ? 2 : 1);
}

/** A check that only says a file or a word exists (`test -f`, `grep -q`, `ls`): red before a new file, it proves no behaviour. */
const EXISTENCE_ONLY = /^\s*(?:cd [^&;|]+&&\s*)?(?:(?:test|\[) -[efsd] \S+\s*\]?|grep -[qcFE]+[qcFE]* .+|ls \S+)\s*$/;
/** The forms EXISTENCE_ONLY reads, one example of each, for the briefs (tasks/gate-vocabulary.ts); a test holds each one against the pattern. */
export const EXISTENCE_ONLY_WORDS: readonly string[] = ["test -f", "test -e", "test -s", "test -d", "grep -q", "grep -c", "ls"];
export const isExistenceOnly = (command: string): boolean => command.split(/\s*(?:&&|;)\s*/).filter(Boolean).every((part) => EXISTENCE_ONLY.test(part));

/**
 * The checks that cannot fail the work: when every check ran green on the base and none is red, they all are. Otherwise nothing is claimed.
 * For a fix, a red check that only looks for a new file or symbol does not count either: vf-s7-restock.2 and four other Vampirism Fire fixes
 * (2026-10-26) passed red-before-green on `test -f Tests/ParNNN.luau` and shipped behaviour no check ran.
 */
export function vacuousChecks(checks: readonly BaselineCheck[], options: { behaviour?: boolean } = {}): BaselineCheck[] {
  if (!checks.length) return [];
  if (checks.every((check) => check.status === "green")) return [...checks];
  if (!options.behaviour) return [];
  const ranAll = checks.every((check) => check.status === "green" || check.status === "red");
  return ranAll && !checks.some((check) => check.status === "red" && !isExistenceOnly(check.command)) ? [...checks] : [];
}

/** What the PM reads when the attempt does not start because no check is red on the base: which checks are vacuous and what to add. */
export function vacuousMessage(taskId: string, vacuous: readonly BaselineCheck[], risk: string, baseSha: string | null, kind?: string): string {
  const list = vacuous.map((check) => `- ${check.command}`).join("\n");
  return `все ${vacuous.length} проверок(и) задачи ${taskId} (риск ${risk}) уже проходят на базе${baseSha ? ` ${baseSha.slice(0, 10)}` : ""}, до писателя:\n${list}\n`
    + `Такие проверки зелёные при любой работе писателя, поэтому не доказывают её. Добавьте хотя бы одну, которая сейчас красная и позеленеет только когда работа сделана: `
    + `проверку, называющую новый файл или поведение (test -f <новый файл>; grep -q '<новый символ>' <файл>; точечный тест, который падает сейчас), и отправьте задачу снова. `
    + `Если у работы нельзя написать красную проверку (чистый рефакторинг, документация), укажите kind refactor или docs.`
    + (kind === "fix" ? ` Для починки (kind fix) проверка наличия файла или слова (test -f, grep -q) не считается: нужен тест поведения, который падает сейчас и проходит после починки.` : "");
}

// ---- a check the base itself shows to be broken: stopped before any writer, with the contract fix named ----

/** How much of a red check's output the baseline keeps. */
export const CHECK_NOTE_TAIL = 600;

type TaskFiles = Pick<TaskV2, "owns_paths" | "expected_outputs" | "project_cwd">;

/**
 * Project-local tools (node_modules/.bin): a baseline worktree whose dependencies could not be linked misses them while the writer's
 * tree has them, so «vitest: command not found» on the base is not proof that the check cannot run.
 */
const LOCAL_TOOLS = new Set(["vitest", "jest", "mocha", "tsc", "tsx", "ts-node", "eslint", "prettier", "stylelint", "vite", "nuxt", "next", "webpack", "rollup",
  "esbuild", "playwright", "prisma", "turbo", "nx", "vue-tsc", "biome", "oxlint"]);

const taskOwns = (path: string, task: TaskFiles): boolean => fileAllowedByOwns(path, task.owns_paths) || task.expected_outputs.some((entry) => entry.replace(/^\.\//, "") === path);
const cwdPrefix = (check: BaselineCheck, task: TaskFiles): string => {
  const relative = posix.relative(task.project_cwd, check.cwd);
  return relative && !relative.startsWith("..") ? relative : "";
};
const inRepo = (check: BaselineCheck, task: TaskFiles, path: string): string => posix.join(cwdPrefix(check, task), path.replace(/^\.\//, ""));
const mentions = (command: string, word: string): boolean => command.split(/[\s;&|()`"']+/).includes(word);

/**
 * Why a check that is red on the base cannot run at all, or null. Only certain signs count: exit 127, a command or folder the shell
 * could not find, npm without a package.json, a flag the runner rejects. Whatever the task itself creates (a script, a package.json
 * under owns_paths) is not missing, it is the work.
 */
export function unrunnableReason(check: BaselineCheck, task: TaskFiles): string | null {
  if (check.status !== "red") return null;
  const note = check.note;
  const missing = /(?:bash|sh|zsh): (?:line \d+: )?(?:\d+: )?([^\s:]+): (?:command not found|No such file or directory)/.exec(note)
    ?? /(?:^|\n)\/?(?:\S*\/)?(?:bash|sh|zsh): (?:\d+: )?([^\s:]+): not found/.exec(note);
  if (check.exitCode === 127 || missing) {
    const name = missing?.[1] ?? null;
    if (name && (LOCAL_TOOLS.has(name) || !mentions(check.command, name))) return null;
    if (name?.includes("/") && taskOwns(inRepo(check, task, name), task)) return null;
    return `exit ${check.exitCode ?? "127"}: ${name ? `\`${name}\` is not found on the machine that runs the checks` : "the shell did not find the command"}`;
  }
  const spawned = /spawn (\S+) ENOENT/.exec(note);
  if (spawned && !LOCAL_TOOLS.has(spawned[1]!) && mentions(check.command, spawned[1]!)) return `\`${spawned[1]}\` cannot be started (spawn ENOENT)`;
  if (/npm (?:error|ERR!) (?:code )?ENOENT/i.test(note) && /package\.json/.test(note)) {
    return taskOwns(inRepo(check, task, "package.json"), task) ? null : `no package.json in ${check.cwd} (npm ENOENT), and the task does not own one`;
  }
  const cd = /\bcd: ([^\s:]+): No such file or directory/.exec(note);
  if (cd) return taskOwns(inRepo(check, task, cd[1]!), task) ? null : `the folder ${cd[1]} does not exist on the base and the task does not create it`;
  if (/CACError: Unknown option `([^`]+)`/.test(note)) return `the runner rejects the option ${/Unknown option `([^`]+)`/.exec(note)![1]}, so the check fails before any test runs`;
  return null;
}

const FILE_IN_OUTPUT = /(?<![\w@./-])((?:\.{1,2}\/)?[\w@.-]+(?:\/[\w@.[\]()-]+)*\.(?:tsx?|jsx?|mjs|cjs|mts|vue|py|rs|go|luau?|php|s?css|json|md|sh|rb|java|kt|swift))(?![\w/-])/g;

/**
 * The files a red check names in its output when ALL of them lie outside the task (not under owns_paths, not an expected output) and the
 * check's own command does not name them: the base is red for reasons the task cannot touch. Empty when the output names no file, names
 * an owned one, or shows a path it cannot place: nothing is claimed then.
 */
export function redOutsideTaskFiles(check: BaselineCheck, task: TaskFiles): string[] {
  if (check.status !== "red" || /(?:^|[\s(])\/[\w.-]+\//.test(check.note)) return [];
  const cut = check.note.length >= CHECK_NOTE_TAIL;
  const files = new Set<string>();
  for (const found of check.note.matchAll(FILE_IN_OUTPUT)) {
    // The tail may begin in the middle of a path.
    if (cut && found.index === 0) continue;
    if (/(^|\/)node_modules\//.test(found[1]!)) continue;
    files.add(found[1]!.replace(/^\.\//, ""));
  }
  if (!files.size) return [];
  const inRepoFiles = [...files].map((file) => inRepo(check, task, file));
  const outside = [...files].every((file, index) => !taskOwns(inRepoFiles[index]!, task) && !taskOwns(file, task) && !check.command.includes(file));
  return outside ? inRepoFiles : [];
}

/** Kinds whose work may be what turns a red check green only through the task's own files; a fix is expected to start red. */
export const RED_OUTSIDE_KINDS: readonly string[] = ["feature", "refactor", "chore"];

/** What the PM reads when a check cannot run on the base: which check, why, what to change. */
export function unrunnableMessage(taskId: string, items: ReadonlyArray<{ check: BaselineCheck; why: string }>, baseSha: string | null): string {
  const list = items.map((item) => `- ${item.check.command} (cwd ${item.check.cwd}): ${item.why}`).join("\n");
  return `проверка(и) задачи ${taskId} не могут выполниться на базе${baseSha ? ` ${baseSha.slice(0, 10)}` : ""}, до писателя:\n${list}\n`
    + `Писатель не сможет её ни пройти, ни починить: упрётся в тот же отказ и задаст вопрос. Исправьте команду или cwd (путь к инструменту, каталог пакета, поддерживаемые флаги) `
    + `либо уберите проверку из verification и отправьте задачу снова. Попытка не потрачена.`;
}

/** What the PM reads when a check of a non-fix task is red on the base in files the task does not own. */
export function redOutsideMessage(taskId: string, items: ReadonlyArray<{ check: BaselineCheck; files: string[] }>, baseSha: string | null): string {
  const list = items.map((item) => `- ${item.check.command}: красная на базе в ${item.files.join(", ")}`).join("\n");
  return `проверка(и) задачи ${taskId} красные на базе${baseSha ? ` ${baseSha.slice(0, 10)}` : ""} вне файлов задачи (owns_paths), до писателя:\n${list}\n`
    + `Писатель этого не исправит и не имеет права: он остановится с вопросом. Сузьте проверку до файлов задачи (запускайте только её тесты или каталог пакета) `
    + `либо расширьте owns_paths на эти файлы, и отправьте задачу снова. Попытка не потрачена.`;
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

/** Checks that were already red on the base and are red after the change too: not this change's regression. */
export function redBeforeAndAfter(baseline: readonly BaselineCheck[], after: ReadonlyArray<{ command: string; exitCode: number; hostError?: true | undefined }>): string[] {
  const red = new Set(baseline.filter((check) => check.status === "red").map((check) => check.command));
  return after.filter((check) => check.exitCode !== 0 && !check.hostError && red.has(check.command)).map((check) => check.command);
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
