import { fileAllowedByOwns } from "@lane-pilot/kit";
import { NO_RED_KINDS, type TaskV2 } from "../../contracts";
import { BASELINE_ALREADY_BUILT_KEY, BASELINE_TIME_CAP_SEC_KEY, CHECKS_REQUIRE_RED_ON_BASE_KEY } from "../settings";

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
  const mode = values[BASELINE_ALREADY_BUILT_KEY];
  const rawRequireRed = values[CHECKS_REQUIRE_RED_ON_BASE_KEY];
  return {
    mode: mode === "stop" ? "stop" : "notify",
    timeCapSec: number(values[BASELINE_TIME_CAP_SEC_KEY]) === 0 ? 0 : bounded(values[BASELINE_TIME_CAP_SEC_KEY], BASELINE_DEFAULTS.timeCapSec, 10, 3600),
    requireRed: rawRequireRed === "off" || rawRequireRed === "high" ? rawRequireRed : "medium",
  };
}

// ---- red before green: a check that is green on the base proves nothing about the work ----

const RISK_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Whether a task of this risk and kind must have a check that is red on the base before its attempt may start. */
export function requiresRedOnBase(setting: RequireRed, task: { risk: string; kind?: string | undefined }): boolean {
  // Feature admission is a hard rule: a feature's check must fail before the writer runs, whatever risk or setting.
  if (task.kind === "feature") return true;
  if (setting === "off") return false;
  if (task.kind && NO_RED_KINDS.includes(task.kind)) return false;
  // A fix has a failure to show, so its risk does not excuse it: five low-risk vf-fix-b1-* of Vampirism Fire (2026-10-26) were accepted on a
  // check.sh that was green on the base, and the first batch run on main found 39 failures. Only the owner's «high» raises the bar above it.
  if (task.kind === "fix" && setting === "medium") return true;
  return (RISK_RANK[task.risk] ?? 0) >= (setting === "high" ? 2 : 1);
}

const TRIVIALLY_TRUE_COMMAND = /^\s*(?:true|:|exit\s+0)\s*$/;
const STATIC_ECHO_COMMAND = /^\s*echo\b[^$|;&]*$/;

/** Checks whether a verification command cannot fail even when the task's behaviour is missing. */
export function isUnfailableCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return true;
  return trimmed.split(/\s*(?:&&|;)\s*/).filter(Boolean).every((part) => TRIVIALLY_TRUE_COMMAND.test(part) || STATIC_ECHO_COMMAND.test(part));
}

/** For a refactor, every check must pass on the base before the writer starts; red checks fail admission. */
export function refactorFailedChecks(checks: readonly BaselineCheck[], task: { kind?: string | undefined }): BaselineCheck[] {
  if (task.kind !== "refactor") return [];
  return checks.filter((check) => check.status === "red");
}

/**
 * Kinds where every check already green means the work is done, so the attempt closes accepted and no writer starts: only
 * a check task, whose whole job is that its checks pass. A fix is not one of them: green checks are as likely to miss the
 * bug as to show it gone — magicseo F1 (2026-10-30, «catalogItems pages through offset/limit») closed accepted on a green
 * client test and tsc with the paging never written, and the PM found it only on the live check. A green fix blocks and
 * asks for a check that is red now, like a feature.
 */
const ALREADY_DONE_KINDS: readonly string[] = ["check"];

/** Whether an all-green baseline closes this task without a writer. Same risk bar as a fix: at `medium` any risk, at `high` only high and critical, never when the gate is off. */
export function closesWhenAlreadyGreen(setting: RequireRed, task: { risk: string; kind?: string | undefined }): boolean {
  if (setting === "off" || !task.kind || !ALREADY_DONE_KINDS.includes(task.kind)) return false;
  if (setting === "medium") return true;
  return (RISK_RANK[task.risk] ?? 0) >= 2;
}

/** A check that only says a file or a word exists (`test -f`, `grep -q`, `ls`): red before a new file, it proves no behaviour. */
const EXISTENCE_ONLY = /^\s*(?:cd [^&;|]+&&\s*)?(?:(?:test|\[) -[efsd] \S+\s*\]?|grep -[qcFE]+[qcFE]* .+|ls \S+)\s*$/;
/** The forms EXISTENCE_ONLY reads, one example of each, for the briefs (tasks/gate-vocabulary.ts); a test holds each one against the pattern. */
export { EXISTENCE_ONLY_WORDS } from "../../contracts";
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

const splitPosix = (path: string) => path.replace(/\/+$/, "").split("/").filter(Boolean);
const posixRelative = (from: string, to: string): string => {
  const a = splitPosix(from), b = splitPosix(to);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...Array(a.length - i).fill(".."), ...b.slice(i)].join("/");
};

const taskOwns = (path: string, task: TaskFiles): boolean => fileAllowedByOwns(path, task.owns_paths) || task.expected_outputs.some((entry) => entry.replace(/^\.\//, "") === path);
const cwdPrefix = (check: BaselineCheck, task: TaskFiles): string => {
  const relative = posixRelative(task.project_cwd, check.cwd);
  return relative && !relative.startsWith("..") ? relative : "";
};
const inRepo = (check: BaselineCheck, task: TaskFiles, path: string): string => {
  const prefix = cwdPrefix(check, task);
  const clean = path.replace(/^\.\//, "");
  return prefix ? `${prefix}/${clean}` : clean;
};
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
  // The check sandbox mounts the workspace writable except `.git/`, `.agents/` and `.cls/` (verification/sandbox.ts): a check that writes
  // there dies with EROFS on the base as after the writer (cab-unslop-library.2, 2026-10-31: build.py made image variants under
  // .agents/prototypes/…/img/_240; the writer's run failed the same way and three sibling tasks were canceled mid-work over it).
  if (/read-only file system/i.test(note)) {
    const where = /Read-only file system: '([^']+)'|read-only file system, \w+ '([^']+)'|[‘'"]([^’'"]+)[’'"]: Read-only file system/i.exec(note);
    const path = where?.[1] ?? where?.[2] ?? where?.[3] ?? null;
    const guard = path ? /\/(\.agents|\.git|\.cls)\//.exec(`/${path}`)?.[1] : null;
    return `it writes ${path ?? "a file"} and the check sandbox refuses (Read-only file system${guard ? `: ${guard}/ is read-only for every check` : ""}); `
      + "a build or generation that writes there is a plan step the writer runs in its session, not a verification command";
  }
  const spawned = /spawn (\S+) ENOENT/.exec(note);
  if (spawned && !LOCAL_TOOLS.has(spawned[1]!) && mentions(check.command, spawned[1]!)) return `\`${spawned[1]}\` cannot be started (spawn ENOENT)`;
  if (/npm (?:error|ERR!) (?:code )?ENOENT/i.test(note) && /package\.json/.test(note)) {
    return taskOwns(inRepo(check, task, "package.json"), task) ? null : `no package.json in ${check.cwd} (npm ENOENT), and the task does not own one`;
  }
  const cd = /\bcd: ([^\s:]+): No such file or directory/.exec(note);
  if (cd) return taskOwns(inRepo(check, task, cd[1]!), task) ? null : `the folder ${cd[1]} does not exist on the base and the task does not create it`;
  // Docker without the CLI plugin a check calls (`docker compose`, `docker buildx`): exit 125, the machine's setup, not the project's code
  // (a writer spent five attempts on one, 2026-10-28).
  const dockerPlugin = /docker: unknown command: docker (\S+)|docker: '([^']+)' is not a docker command/.exec(note);
  if (dockerPlugin && mentions(check.command, "docker")) return `\`docker ${dockerPlugin[1] ?? dockerPlugin[2]}\` is not available on the machine that runs the checks (the Docker CLI plugin is missing)`;
  if (/CACError: Unknown option `([^`]+)`/.test(note)) return `the runner rejects the option ${/Unknown option `([^`]+)`/.exec(note)![1]}, so the check fails before any test runs`;
  return null;
}

const FILE_IN_OUTPUT = /(?<![\w@./-])((?:\.{1,2}\/)?[\w@.-]+(?:\/[\w@.[\]()-]+)*\.(?:tsx?|jsx?|mjs|cjs|mts|vue|py|rs|go|luau?|php|s?css|json|md|sh|rb|java|kt|swift))(?![\w/-])/g;

/** A sign that a line of output reports a failure (read with the file names cut out, so `src/errors.ts` is not one). */
const FAILURE_SIGN = /\b(?:error|fail(?:ed|ure|s)?|ERR!?|exception|panic(?:ked)?|cannot|not found|expected|assert\w*|undefined|missing|line \d+)\b|✖|✗|×|❯|-->|:\d+(?::\d+)?\b|\(\d+,\d+\)/i;
/** A line that reports a pass: a test title there may contain any word. */
const PASS_LINE = /^\s*(?:✔|✓|√|PASS\b|ok \d)/;

/** A Node runtime stack frame can make its function label look like a source file (`Object..js`). */
function isNodeInternalFrame(line: string, file: string): boolean {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*at\\s+${escaped}\\s+\\(node:internal\\/[^)]*\\)$`).test(line);
}

/**
 * The lines of a red check's output that report a failure: the file names a check prints while it works (a build's list of what it
 * wrote, a passing test) are not why it is red. A line with a path and nothing else counts when the line after it reports the failure
 * (eslint names the file, then its errors).
 */
function failureLines(note: string): Set<number> {
  const lines = note.split("\n");
  const failing = (line: string | undefined) => line !== undefined && !PASS_LINE.test(line) && FAILURE_SIGN.test(line.replace(FILE_IN_OUTPUT, " "));
  const found = new Set<number>();
  lines.forEach((line, index) => {
    if (failing(line)) found.add(index);
    else if (!line.replace(FILE_IN_OUTPUT, "").trim() && failing(lines.slice(index + 1).find((next) => next.trim()))) found.add(index);
  });
  return found;
}

/**
 * The files a red check names in its output when ALL of them lie outside the task (not under owns_paths, not an expected output) and the
 * check's own command does not name them: the base is red for reasons the task cannot touch. Only files on lines that report a failure
 * count. Empty when the output names no such file, names an owned one, or shows a path it cannot place: nothing is claimed then.
 */
export function redOutsideTaskFiles(check: BaselineCheck, task: TaskFiles): string[] {
  if (check.status !== "red" || /(?:^|[\s(])\/[\w.-]+\//.test(check.note)) return [];
  const cut = check.note.length >= CHECK_NOTE_TAIL;
  const failing = failureLines(check.note);
  const lineOf = (offset: number) => check.note.slice(0, offset).split("\n").length - 1;
  const files = new Set<string>();
  for (const found of check.note.matchAll(FILE_IN_OUTPUT)) {
    // The tail may begin in the middle of a path.
    if (cut && found.index === 0) continue;
    // `bb plugin build` lists dist/* after it succeeds, and a later `grep -q` is red silently: those names are not the failure.
    if (!failing.has(lineOf(found.index))) continue;
    if (/(^|\/)node_modules\//.test(found[1]!)) continue;
    const lineStart = check.note.lastIndexOf("\n", found.index) + 1;
    const lineEnd = check.note.indexOf("\n", found.index);
    const line = check.note.slice(lineStart, lineEnd < 0 ? check.note.length : lineEnd);
    // Node's internal frames are failure context, not project files; only ignore a token in this exact frame shape.
    if (isNodeInternalFrame(line, found[1]!)) continue;
    // `Node.js v26` closes every uncaught Node error; it names the runtime, not a file.
    if (/^(?:node|next|nuxt|vue|express)\.js$/i.test(found[1]!)) continue;
    files.add(found[1]!.replace(/^\.\//, ""));
  }
  if (!files.size) return [];
  const inRepoFiles = [...files].map((file) => inRepo(check, task, file));
  const outside = [...files].every((file, index) => !taskOwns(inRepoFiles[index]!, task) && !taskOwns(file, task) && !check.command.includes(file));
  return outside ? inRepoFiles : [];
}

/** Kinds whose work may be what turns a red check green only through the task's own files; a fix is expected to start red. */
export const RED_OUTSIDE_KINDS: readonly string[] = ["feature", "refactor", "chore"];



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
