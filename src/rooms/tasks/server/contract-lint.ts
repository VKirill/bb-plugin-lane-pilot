import { birthFindings, blockingClass, checkProgram, ownerWordFindings } from "../rails";
import { dirname, resolve } from "node:path";
import { TASK_KINDS, type TaskV2 } from "../../contracts";
import { fileAllowedByOwns, fileBlockedByNeverTouch, matchOwnsPath, ownsPathsOverlap } from "@lane-pilot/kit";
import { findSandboxUnsafeMissingExcludes, runnerFilterArgs, runsWholeSuite } from "../../critique";
import { NO_RED_KINDS } from "../../baseline";
import { parseReadFirstHints } from "../read-first";
import { maskedExitReason, passWithNoTestsReason } from "./lint-exit-status";
import { SUBJECTIVE_WORDS, browserQaRequired } from "../../critique";
import type { QualityMode } from "../../critique";
import { isMainfixTask, isOutputPath, unownedExpectedOutputs } from "../validate-output";
import { mapVerificationCwd } from "../verification-cwd";
import { SANDBOX_OWN_ENV } from "../../verification";
import type { CatalogEntry, SecretCheck } from "../../secrets/server";
import { safeRelative, validateOwnershipContract } from "../../verification";
import { CHECK_HISTORY_MIN_RUNS, p95 } from "../check-history";

/** One problem in a task contract, with the concrete fix; `data` rides along in the answer to the PM. */
export type LintFinding = { code:string; message:string; data?:Record<string, unknown> };
export type PathKind = "missing" | "file" | "directory" | "symlink" | "other";
export type LintOpenTask = { id:string; owns_paths:string[]; never_touch:string[]; depends_on:string[] };
export type LintInput = {
  task:TaskV2;
  workspacePath:string;
  hostId:string;
  /** Kinds of lintProbePaths on the workspace's machine; null when that machine could not be asked (those rules then stay silent). */
  kinds:ReadonlyMap<string, PathKind> | null;
  /** File names in the siblingTestFolders on the workspace's machine (absolute folder → names); absent or null when it was not asked. */
  listings?:ReadonlyMap<string, readonly string[]> | null;
  sandboxUnsafe:readonly string[];
  /** Is the check command runnable: the programs the checks start, and whether the writer's machine finds them; null when it was not asked. */
  programs?:ReadonlyMap<string, boolean> | null;
  /** The project's integration gate (explicit or detected) runs the whole suite once per batch; absent or null when there is none. */
  gate?:{ command:string } | null;
  /** What the project has recorded of one check command: the durations of its green runs and the limits it timed out at; absent when the history was not asked. */
  checkHistory?:(check:{ command:string; cwd:string }) => { greenMs:readonly number[]; timedOutSec:readonly number[] };
  /** The project asks for the owner's word (setting owner.words = on): a clarification counts only with his answer. */
  ownerWords?:boolean;
  /** The quality mode the task runs in (its own, else the project setting); absent when it was not resolved, and the browser-check rule then stays silent. */
  qualityMode?:QualityMode;
  /** Other open tasks of the project. */
  openTasks:readonly LintOpenTask[];
  /** depends_on names whose latest task ended blocked or canceled and that nothing restarts or vouches for. */
  deadDependencies:readonly { id:string; state:"blocked" | "canceled" }[];
  /** Env Catalog's answer for the secrets the checks declare (J2); absent when none is declared. */
  secrets?:SecretCheck & { catalog:readonly CatalogEntry[] | null };
};

export { runnerFilterArgs };

/** The timeout a check without timeout_sec gets (the sandbox's default, writer/server/verify.ts). */
const DEFAULT_CHECK_TIMEOUT_SEC = 120;

/**
 * Whether a check runs the gate's own command: the check is the gate command, or one `&&` / `;` step of it (after `cd dir &&`) is. The gate
 * is whatever the project's integration.gate_command says, so this holds for a runner the lint has no name for (Vampirism Fire:
 * `python3 -I scripts/studio_test.py`, the whole Studio suite, used as a task check 40 times).
 */
export function runsGateCommand(command:string, gateCommand:string):boolean {
  const squash = (text:string) => text.trim().replace(/\s+/g, " ");
  const gate = squash(gateCommand);
  return squash(command) === gate || command.split(/&&|;|\n/).map(squash).some((part) => part === gate.replace(/^cd \S+ && /, ""));
}

const TEST_BIN = /(?:^|\/)(vitest|jest|pytest|py\.test)$/;
const SCRIPT_RUNNER = /(?:^|\/)([\w.-]+\.(?:py|js|mjs|cjs|ts|sh))$/;

/** Which test runner one `&&` / `;` step starts, or null. A `cd` or a typecheck is not a runner. */
function runnerOf(segment:string):string | null {
  const tokens = segment.trim().split(/\s+/).map((token) => token.replace(/^['"]|['"]$/g, ""));
  const bin = tokens.find((token) => TEST_BIN.test(token));
  if (bin) return bin.replace(/^.*\//, "");
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?(?:test|t)(?:\s|$)/.test(segment.trim())) return "npm-test";
  for (const token of tokens) {
    const script = SCRIPT_RUNNER.exec(token);
    if (script) return script[1]!;
  }
  return null;
}

/**
 * The runner a check starts more than once, or null. `--filter A && --filter B` is two runs of one suite in a single check
 * (Vampirism Fire: each filter still takes minutes, and a red first filter has already spent them).
 */
export function repeatedRunner(command:string):string | null {
  const seen = new Map<string, number>();
  for (const part of command.split(/&&|;|\n/)) {
    const key = runnerOf(part);
    if (!key) continue;
    if ((seen.get(key) ?? 0) >= 1) return key;
    seen.set(key, 1);
  }
  return null;
}

/** The catalog name closest to a declared one when they differ by case or a typo (at most two edits); null when none is near. */
export function nearSecretName(name:string, catalog:readonly CatalogEntry[]):string | null {
  const distance = (a:string, b:string):number => {
    const row = Array.from({ length:b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
      let diagonal = row[0]!;
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const above = row[j]!;
        row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
        diagonal = above;
      }
    }
    return row[b.length]!;
  };
  let best:{ name:string; d:number } | null = null;
  for (const entry of catalog) {
    const d = distance(name.toLowerCase(), entry.name.toLowerCase());
    if (d <= 2 && (!best || d < best.d)) best = { name:entry.name, d };
  }
  return best?.name ?? null;
}
const MAX_PROBES = 128;

/** The first subjective word (stages/role-method.ts) a criterion rests on, matched as a whole word in any letter case; null when there is none. */
export function subjectiveWordIn(text:string):string | null {
  const lower = text.toLowerCase();
  return SUBJECTIVE_WORDS.find((word) => new RegExp(`(^|[^\\p{L}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "u").test(lower)) ?? null;
}

const folderFilters = (task:TaskV2) => task.verification.flatMap((check, index) =>
  runnerFilterArgs(check.command).filter((arg) => !arg.endsWith("/")).map((arg) => ({ index, command:check.command, arg, path:resolve(check.cwd, arg) })));

/** One shell command that changes nothing and exits 0, whatever the code does. */
const NO_OP_SEGMENT = /^(?:true|:|exit(?:\s+0)?|\/(?:usr\/)?bin\/true|echo\b.*|printf\b.*|sleep\s+[\d.]+|pwd|cd\s+\S+|set\s+[-+]\w+(?:\s+[-+]?\w+)*|(?:test|\[)\s+1\s+(?:-eq|=)\s+1\s*\]?)$/;

/**
 * Why a verification command cannot fail, or null when it can: `true`, `:`, `exit 0`, a bare `echo …`, a chain of only those, or a
 * real command whose failure is swallowed (`npm test || true`, `npm test; exit 0`). Such a check passes whatever the writer did.
 */
export function emptyCheckReason(command:string):string | null {
  let text = command.trim();
  const wrapped = /^(?:ba|z)?sh\s+-c\s+(['"])([\s\S]*)\1$/.exec(text);
  if (wrapped) text = wrapped[2]!.trim();
  const segments = text.split(/&&|\|\||;|\n/).map((part) => part.trim()).filter(Boolean);
  const piped = /(^|[^|])\|(?!\|)/.test(text);
  if (segments.every((part) => NO_OP_SEGMENT.test(part)) && !piped) return "does nothing and always exits 0";
  if (/(?:\|\||;)\s*(?:true|:|exit\s+0)\s*;?$/.test(text)) return "ends in `|| true`, `; true` or `; exit 0`, which turns a failure into a pass";
  return null;
}

const EXISTENCE_SEGMENT = /^(?:(?:test|\[\[?)\s+-[fedsr]\s+(\S+?)(?:\s*\]\]?)?|ls(?:\s+-[A-Za-z]+)*\s+(\S+)|stat\s+(\S+))$/;

/**
 * The paths a check only tests the existence of (`test -f a.ts && test -d b`, `[ -f a.ts ]`, `ls a.ts`), or null when the command does anything
 * else. Such a check is red on the base only for a path the base lacks.
 */
export function existenceOnlyPaths(command:string):string[] | null {
  const segments = command.trim().split(/\s*&&\s*|;|\n/).map((part) => part.trim()).filter(Boolean);
  if (!segments.length || /\|/.test(command)) return null;
  const paths:string[] = [];
  for (const segment of segments) {
    const hit = EXISTENCE_SEGMENT.exec(segment);
    const raw = hit?.[1] ?? hit?.[2] ?? hit?.[3];
    if (!raw) return null;
    paths.push(raw.replace(/^['"]+|['"]+$/g, "").replace(/^\.\//, ""));
  }
  return paths;
}

/** The files a check names (a token with a slash or an extension), absolute, in the folder the check runs in. */
export function checkNamedPaths(task:Pick<TaskV2, "verification">):string[] {
  const found = new Set<string>();
  for (const check of task.verification) for (const raw of check.command.split(/\s+/)) {
    const token = raw.replace(/^['"]+|['"]+$/g, "").replace(/^\.\//, "");
    if (!token || token.startsWith("-") || token.startsWith("$") || /[=*?[\]{}()<>|&;`]/.test(token)) continue;
    if (token.includes("/") || /\.[A-Za-z0-9]{1,6}$/.test(token)) found.add(resolve(check.cwd, token));
  }
  return [...found];
}

const TS_SOURCE = /\.(?:ts|tsx|vue)$/, JS_SOURCE = /\.(?:js|jsx|mjs|cjs)$/, TEST_FILE = /(^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[A-Za-z]+$/;

/**
 * The tests that may sit next to an owned code file («composables/useHreflang.ts» → «composables/__tests__/useHreflang.test.ts»,
 * «composables/useHreflang.test.ts»), and the «__tests__» folder next to a file-name glob («composables/useGreetingCard*»).
 * A writer updates the tests of the code it changes; when owns_paths leaves them out the attempt is rejected for it.
 */
export function siblingTestCandidates(task:Pick<TaskV2, "owns_paths">):Array<{ owned:string; test:string; folder?:string }> {
  const found:Array<{ owned:string; test:string; folder?:string }> = [];
  for (const raw of task.owns_paths) {
    const owned = raw.replace(/^\.\//, "");
    const slash = owned.lastIndexOf("/");
    const dir = slash < 0 ? "" : owned.slice(0, slash + 1), name = owned.slice(slash + 1);
    if (!name || /[*?[]/.test(dir) || TEST_FILE.test(owned)) continue;
    if (/[*?[]/.test(name)) {
      if (name !== "*" && name !== "**") found.push({ owned, test:`${dir}__tests__/${name}`, folder:`${dir}__tests__` });
      continue;
    }
    const exts = TS_SOURCE.test(name) ? [".test.ts", ".spec.ts", ".test.tsx"] : JS_SOURCE.test(name) ? [".test.js", ".spec.js", ".test.mjs"] : [];
    const stem = name.replace(/\.[^.]+$/, "");
    if (stem === "index") continue;
    for (const where of [dir, `${dir}__tests__/`]) for (const ext of exts) found.push({ owned, test:`${where}${stem}${ext}` });
  }
  return found;
}

const TEST_NAME = /\.(?:test|spec)\.[cm]?[jt]sx?$/, CODE_NAME = /\.(?:[cm]?[jt]sx?|vue)$/;
const MAX_LISTED_FOLDERS = 64;

/** The owned code files whose tests may carry a longer name: a plain path to a TS/JS/Vue file that is not a test or an index. */
function ownedCodeFiles(task:Pick<TaskV2, "owns_paths">):Array<{ owned:string; dir:string; stem:string }> {
  const found:Array<{ owned:string; dir:string; stem:string }> = [];
  for (const raw of task.owns_paths) {
    const owned = raw.replace(/^\.\//, "");
    const slash = owned.lastIndexOf("/");
    const dir = slash < 0 ? "" : owned.slice(0, slash + 1), name = owned.slice(slash + 1);
    if (!name || /[*?[]/.test(owned) || TEST_FILE.test(owned) || !(TS_SOURCE.test(name) || JS_SOURCE.test(name))) continue;
    const stem = name.replace(/\.[^.]+$/, "");
    if (stem && stem !== "index") found.push({ owned, dir, stem });
  }
  return found;
}

/** Absolute folders the lint lists for tests named after an owned code file: the file's own folder and its «__tests__». */
export function siblingTestFolders(task:Pick<TaskV2, "owns_paths">, workspacePath:string):string[] {
  const folders = ownedCodeFiles(task).flatMap(({ dir }) => [resolve(workspacePath, dir || "."), resolve(workspacePath, `${dir}__tests__`)]);
  return [...new Set(folders)].slice(0, MAX_LISTED_FOLDERS);
}

/**
 * The tests next to an owned code file that carry a longer name: «composables/api/shoot.ts» → «composables/api/__tests__/shoot-seo-audit.test.ts»
 * («shoot» and then «-», «_» or «.»), read from the folder listings. A test whose longer name is another code file's in that folder
 * («tools-hubs.test.ts» beside «tools-hubs.ts») is that file's, not the owned one's.
 */
export function namedTestCandidates(task:Pick<TaskV2, "owns_paths">, workspacePath:string, listings:ReadonlyMap<string, readonly string[]>):Array<{ owned:string; test:string }> {
  const found:Array<{ owned:string; test:string }> = [];
  const stemOf = (name:string) => name.replace(/\.(?:test|spec)\.[^.]+$/, "").replace(/\.[^.]+$/, "");
  const startsAs = (testStem:string, stem:string) => testStem === stem || ["-", "_", "."].some((sep) => testStem.startsWith(`${stem}${sep}`));
  for (const { owned, dir, stem } of ownedCodeFiles(task)) {
    const here = listings.get(resolve(workspacePath, dir || ".")) ?? [];
    const codeStems = here.filter((name) => CODE_NAME.test(name) && !TEST_NAME.test(name)).map(stemOf);
    for (const [where, names] of [[dir, here], [`${dir}__tests__/`, listings.get(resolve(workspacePath, `${dir}__tests__`)) ?? []]] as const) {
      for (const name of names) {
        if (!TEST_NAME.test(name)) continue;
        const testStem = stemOf(name);
        if (!startsAs(testStem, stem) || codeStems.some((other) => other.length > stem.length && startsAs(testStem, other))) continue;
        found.push({ owned, test:`${where}${name}` });
      }
    }
  }
  return found;
}

/** A concrete file path (a basename with an extension, no glob), or null for a folder, a glob or a bare name. */
function concreteFile(path:string):string | null {
  const norm = path.replace(/^\.\//, "").replace(/\/$/, "");
  if (!norm || /[*?[]/.test(norm) || !/(?:^|\/)[^/]*\.[A-Za-z0-9]{1,8}$/.test(norm)) return null;
  return norm;
}

/** The task creates the file: it is an expected output, or files[] says create. */
function taskCreatesFile(task:Pick<TaskV2, "expected_outputs" | "files">, path:string):boolean {
  if (task.expected_outputs.some((entry) => entry.replace(/^\.\//, "") === path)) return true;
  return (task.files ?? []).some((file) => file.action === "create" && file.path.replace(/^\.\//, "") === path);
}

/** Absolute paths whose kind the workspace's machine must report: the read_first files, the bare words of check filters, the tests next to owned files, and the concrete files the contract names. */
export function lintProbePaths(task:TaskV2, workspacePath:string):string[] {
  let hints:string[] = [];
  try { hints = parseReadFirstHints(task.read_first).map((hint) => resolve(workspacePath, hint.path)); } catch { /* reported by lintContract */ }
  const tests = siblingTestCandidates(task).map((candidate) => resolve(workspacePath, candidate.folder ?? candidate.test));
  const named = [...task.owns_paths, ...task.expected_outputs, ...(task.files ?? []).map((file) => file.path)]
    .map(concreteFile).filter((path):path is string => !!path)
    .flatMap((path) => {
      const dir = dirname(path);
      return dir === "." ? [resolve(workspacePath, path)] : [resolve(workspacePath, path), resolve(workspacePath, dir)];
    });
  return [...new Set([...hints, ...folderFilters(task).map((filter) => filter.path), ...tests, ...checkNamedPaths(task), ...named])].slice(0, MAX_PROBES);
}

/** The board shows about 60 characters; a longer title is cut there, never refused below this (owner, 2026-10-27: models must not stumble on title length). */
export const DISPLAY_TITLE_MAX = 1000;

/**
 * The task standard the Tasks board shows from: a card title in the owner's language, a kind and an area. Lane Pilot's own tasks
 * (mainfix, workflow chains) fill the three themselves, so only a PM's contract is ever refused here.
 */
export function taskStandardFindings(task:Pick<TaskV2, "display_title" | "kind" | "area">):LintFinding[] {
  const found:LintFinding[] = [];
  const title = task.display_title?.trim() ?? "";
  if (!title) found.push({ code:"display_title_missing", message:"display_title is missing: add the card title for the Tasks board, in the language the owner writes in, short (~60 characters read best), what changes for a person, no ids or paths (for a Russian-speaking owner: \"Страница заказов в кабинете\")" });
  else if ([...title].length > DISPLAY_TITLE_MAX) found.push({ code:"display_title_too_long", message:`display_title is ${[...title].length} characters, the limit is ${DISPLAY_TITLE_MAX}; shorten it to what changes for a person (for a Russian-speaking owner: "Страница заказов в кабинете")` });
  if (!task.kind || !(TASK_KINDS as readonly string[]).includes(task.kind)) found.push({ code:"kind_missing", message:`kind is missing or not one of ${TASK_KINDS.join(", ")}: add the one that fits (a new capability is "feature", a bug is "fix", a verification-only task is "check")` });
  if (!task.area?.trim()) found.push({ code:"area_missing", message:"area is missing: add the page or feature the task belongs to, one per task (\"page:/tools/cards\", \"feature:checkout\"); tasks of one area run one at a time in the same writer thread" });
  return found;
}

/** Everything a task contract gets wrong before any helper or writer runs; errors send the task back to the PM, warnings go along with the answer. */
export function lintContract(input:LintInput):{ errors:LintFinding[]; warnings:LintFinding[] } {
  const { task, kinds } = input;
  const errors:LintFinding[] = [], warnings:LintFinding[] = [];
  const kindOf = (path:string) => kinds?.get(path);

  errors.push(...taskStandardFindings(task));
  // Hub plan-fact receipts since 2026-10-29, live projects only: failed 15.8% at 3 acceptance items, 28.9% at 4, 32.7% at 5+
  // (n 76/83/156); not-accepted is flat ~31-33% at any length, so the threshold is a plan-fact one, not an acceptance one.
  // The refusal is a redo, not a verdict: lintTask lets the same task id through once, then keeps it as a warning.
  // Full mode may keep a longer list; a mainfix lists every red check.
  const acceptanceMode = input.qualityMode ?? task.quality_mode;
  if (!isMainfixTask(task.id) && (acceptanceMode === "quick" || acceptanceMode === "standard") && task.acceptance.length > 3) {
    errors.push({ code:"acceptance_too_many", message:`acceptance has ${task.acceptance.length} items; a ${acceptanceMode} task keeps at most 3, because plan-fact fails about twice as often above that (hub receipts since 2026-10-29: 15.8% at 3, 28.9% at 4, 32.7% at 5+). Split the task or compress acceptance to 3 items; a second dispatch of this same task id goes through with a warning` });
  }
  // quality_mode full: a task with qa_cases owes a browser check, and the task's own graph runs it from qa_url.
  if (input.qualityMode && browserQaRequired(input.qualityMode, task) && !task.qa_url) {
    errors.push({ code:"qa_url_missing", message:`quality_mode is full and the task has qa_cases, so its graph runs the browser check itself and needs the page to open: add qa_url (the address the cases run on, e.g. "http://127.0.0.1:5173/orders"), plus qa_env_class (local, staging, preview, production or unknown) and qa_dev_server (the command that starts the dev server, when it is not running); or drop qa_cases` });
  }
  // The task-birth rails (src/rooms/tasks/rails.ts): open clarification, the promise in Given/When/Then words, the drawing a screen task follows.
  const birth = birthFindings(task);
  errors.push(...birth.errors, ...ownerWordFindings(task, input.ownerWords === true));
  warnings.push(...birth.warnings);
  for (const [index, check] of task.verification.entries()) {
    const program = checkProgram(check.command);
    if (program && !program.includes("/") && input.programs?.get(program) === false) {
      errors.push({ code:"check_not_runnable", message:`verification[${index}] starts ${program}, which the writer's machine (${input.hostId}) does not find on PATH, among the user's tool bins or in node_modules/.bin; install it there or use a command that exists` });
    }
  }

  // read_first: a project-relative path that exists on the writer's machine and is a file.
  try {
    for (const hint of parseReadFirstHints(task.read_first)) {
      const kind = kindOf(resolve(input.workspacePath, hint.path));
      if (kind === "directory") errors.push({ code:"read_first_folder", message:`read_first is a directory, not a file: ${hint.path}/ is a folder; name the files inside it (read_first takes files, optionally with line windows), or put the folder in owns_paths` });
      else if (kind === "symlink" || kind === "other") errors.push({ code:"read_first_not_file", message:`read_first is not a regular file (${kind}): ${hint.path}; point it at the real file` });
      else if (kind === "missing" && !task.depends_on.length && !task.expected_outputs.some((entry) => entry.replace(/^\.\//, "") === hint.path)) {
        errors.push({ code:"read_first_missing", message:`read_first source is missing: ${hint.path} does not exist on the writer's machine (${input.hostId}); correct the path, or drop it when the task creates that file` });
      }
    }
  } catch (cause) {
    errors.push({ code:"read_first_path", message:cause instanceof Error ? cause.message : String(cause) });
  }

  // owns_paths and never_touch stay inside the project root, and a path is not both owned and forbidden.
  const unsafe = [["owns_paths", task.owns_paths], ["never_touch", task.never_touch]] as const;
  for (const [field, patterns] of unsafe) for (const pattern of patterns) {
    if (!safeRelative(pattern)) errors.push({ code:"ownership_unsafe", message:`unsafe ownership path pattern: ${pattern} in ${field}; use a path relative to the project root, without "..", a leading "/" or backslashes` });
  }
  // A check runs in a folder of the project: an absolute cwd under project_cwd, or a relative one. Anything else has no copy in the attempt's worktree.
  for (const [index, check] of task.verification.entries()) {
    if (mapVerificationCwd(check.cwd, task.project_cwd, task.project_cwd) === null) {
      errors.push({ code:"verification_cwd", message:`verification[${index}] cwd ${check.cwd} is outside the project ${task.project_cwd}, so the check cannot run in the attempt's worktree; use ${task.project_cwd} or a folder under it (for example ${task.project_cwd}/apps/web, or the relative path apps/web)` });
    }
  }
  if (!errors.some((error) => error.code === "ownership_unsafe" || error.code === "verification_cwd")) {
    const rest = validateOwnershipContract(task);
    if (rest) errors.push({ code:"ownership_contract", message:rest });
  }
  for (const pattern of task.owns_paths) {
    if (/[*?[]/.test(pattern)) continue;
    const barred = task.never_touch.find((never) => matchOwnsPath(pattern, never));
    if (barred) errors.push({ code:"owns_never_touch", message:`owns_paths ${pattern} lies inside never_touch ${barred}, so the writer may not change it; remove one of the two` });
  }
  // A concrete file that is not on the base and that the task does not create is a wrong path: the writer cannot edit it and will not produce it.
  // read_first already reports its own missing files. A folder or a glob is where new files go, so it is not a missing file.
  if (kinds) {
    let readFirst = new Set<string>();
    try { readFirst = new Set(parseReadFirstHints(task.read_first).map((hint) => hint.path)); } catch { /* reported above */ }
    // A missing file in an existing folder reads as a create the author did not mark (owner 2026-10-30): a warning, never a
    // refusal. The refusal holds only when the folder itself is not there — the path is a typo, not a create.
    for (const pattern of task.owns_paths) {
      const path = concreteFile(pattern);
      if (!path || readFirst.has(path) || taskCreatesFile(task, path) || kindOf(resolve(input.workspacePath, path)) !== "missing") continue;
      const dirKind = dirname(path) === "." ? "directory" : kindOf(resolve(input.workspacePath, dirname(path)));
      if (dirKind === "missing") {
        errors.push({ code:"owns_missing", message:`owns_paths ${path} does not exist and neither does its folder ${dirname(path)}: the path is a wrong name, not a file the task will create; fix the path` });
        if (errors.filter((error) => error.code === "owns_missing").length >= 5) break;
      } else {
        warnings.push({ code:"owns_unmarked_create", message:`owns_paths ${path} does not exist but its folder does; the lint reads it as a file the task creates — declare it in expected_outputs or a files[] create if so` });
        if (warnings.filter((warning) => warning.code === "owns_unmarked_create").length >= 5) break;
      }
    }
    for (const file of task.files ?? []) {
      if (file.action === "create") continue;
      const path = concreteFile(file.path);
      if (!path || taskCreatesFile(task, path) || kindOf(resolve(input.workspacePath, path)) !== "missing") continue;
      const dirKind = dirname(path) === "." ? "directory" : kindOf(resolve(input.workspacePath, dirname(path)));
      if (dirKind === "missing") {
        errors.push({ code:"output_missing", message:`files[] ${file.action} ${path} does not exist and neither does its folder ${dirname(path)}: fix the path, or set action create and add the file to expected_outputs if the task creates it` });
        if (errors.filter((error) => error.code === "output_missing").length >= 5) break;
      } else {
        warnings.push({ code:"output_unmarked_create", message:`files[] ${file.action} ${path} does not exist but its folder does; the lint reads it as a create — set action create and add it to expected_outputs if so` });
        if (warnings.filter((warning) => warning.code === "output_unmarked_create").length >= 5) break;
      }
    }
  }

  // expected_outputs inside owns_paths and outside never_touch.
  for (const entry of unownedExpectedOutputs(task).slice(0, 5)) {
    errors.push({ code:"output_unowned", message:`expected_outputs ${entry} is outside owns_paths, so the writer may not create it and no attempt can pass; add it (or its folder) to owns_paths, or drop it from expected_outputs` });
  }
  for (const entry of task.expected_outputs.filter((item) => item.includes("/") && isOutputPath(item) && fileBlockedByNeverTouch(item.replace(/^\.\//, ""), task.never_touch)).slice(0, 5)) {
    errors.push({ code:"output_never_touch", message:`expected_outputs ${entry} is inside never_touch, so the writer may not create it; drop it from expected_outputs or narrow never_touch` });
  }

  // convergence.criteria must be decidable by a command, a grep or a file read: no subjective words.
  for (const [index, criterion] of (task.convergence?.criteria ?? []).entries()) {
    const word = subjectiveWordIn(criterion);
    if (word) errors.push({ code:"criteria_subjective", message:`convergence.criteria[${index}] rests on the subjective words «${word}», which no command can decide; name the exact string, value or exit code a command, a grep or a file read checks («src/a.ts contains 'LIMIT = 10'», «the command exits 0»)` });
  }
  // files[] is a hint for the writer: the files it names are the task's own.
  for (const [index, file] of (task.files ?? []).entries()) {
    const path = file.path.replace(/^\.\//, "");
    if (!safeRelative(path)) errors.push({ code:"files_unsafe", message:`files[${index}] path ${file.path} must be relative to the project root, without "..", a leading "/" or backslashes` });
    else if (!fileAllowedByOwns(path, task.owns_paths)) errors.push({ code:"files_unowned", message:`files[${index}] ${path} is outside owns_paths, so the writer may not change it; add it (or its folder) to owns_paths, or drop it from files` });
    else if (fileBlockedByNeverTouch(path, task.never_touch)) errors.push({ code:"files_never_touch", message:`files[${index}] ${path} is inside never_touch, so the writer may not change it; drop it from files or narrow never_touch` });
  }

  // An owned code file's own test is the task's too: the writer updates it with the code, and an edit outside owns_paths
  // rejects the attempt (SelfyStudio cards-postpay-bind-v2, greeting-card-pages-en, en-hreflang-sitemap-fix, 2026-10-11…12:
  // each owned «x.ts» or «useGreetingCard*», not «__tests__/x.test.ts», and lost an attempt to it). never_touch says «leave it».
  // A test named longer than the code («api/shoot.ts» → «api/__tests__/shoot-seo-audit.test.ts») comes from the folder listings: SelfyStudio
  // site-en-shoot, site-seo-polish, site-vitest-alias-fix and site-en-hydration-fix (2026-10-24) each owned shoot.ts, cards.ts or models.ts,
  // not the «shoot-seo-audit», «cards-seo-audit» or «models-en» test the change turned red, and lost an attempt to it.
  // One finding per owned file names all of its unowned tests, so the PM fixes them in one pass (site-seo-polish had nine).
  const flagged = new Map<string, { owned:string; folder?:string; tests:string[] }>();
  const named = input.listings ? namedTestCandidates(task, input.workspacePath, input.listings).map((candidate) => ({ ...candidate, folder:undefined, listed:true })) : [];
  const seen = new Set<string>();
  for (const candidate of [...siblingTestCandidates(task).map((candidate) => ({ ...candidate, listed:false })), ...named]) {
    const present = candidate.listed || (candidate.folder ? kindOf(resolve(input.workspacePath, candidate.folder)) === "directory" : kindOf(resolve(input.workspacePath, candidate.test)) === "file");
    if (!present || seen.has(candidate.test) || seen.size >= 20) continue;
    if (fileAllowedByOwns(candidate.test, task.owns_paths) || fileBlockedByNeverTouch(candidate.test, task.never_touch)) continue;
    const key = `${candidate.owned}\u0000${candidate.folder ?? ""}`;
    if (!flagged.has(key) && flagged.size >= 5) continue;
    seen.add(candidate.test);
    const group = flagged.get(key) ?? { owned:candidate.owned, ...(candidate.folder ? { folder:candidate.folder } : {}), tests:[] };
    group.tests.push(candidate.test);
    flagged.set(key, group);
  }
  for (const { owned, folder, tests } of flagged.values()) {
    const what = folder ? `tests in ${folder}` : tests.length > 1 ? `its tests ${tests.join(", ")}` : `its test ${tests[0]}`;
    errors.push({ code:"test_unowned", message:`owns_paths ${owned} has ${what} outside owns_paths; the writer updates the tests of the code it changes and an edit there rejects the attempt, so add ${tests.join(", ")} to owns_paths, or to never_touch if the writer must leave ${tests.length > 1 ? "them" : "it"} as ${tests.length > 1 ? "they are" : "it is"}` });
  }

  // A check that cannot fail proves nothing; a task of medium risk or more needs one that fails until its work exists.
  for (const [index, check] of task.verification.entries()) {
    const why = emptyCheckReason(check.command);
    if (why) errors.push({ code:"verification_empty_check", message:`verification[${index}] command "${check.command}" ${why}, so it passes whatever the writer does; replace it with a check that fails when the work is missing (the task's own test file, a grep for the expected string, test -f on a new file, a typecheck)` });
  }
  // A check that cannot see its own failure: a pipe into `tail`, a runner flag that passes when no test ran (rules 30694c, 45b334).
  for (const [index, check] of task.verification.entries()) {
    const masked = maskedExitReason(check.command);
    if (masked) errors.push({ code:"verification_masked_exit", message:`verification[${index}] command "${check.command}" ${masked}; start the command with \`set -o pipefail;\` (checks run in bash) or drop the pipe, so the check fails when the command before it fails` });
    const none = passWithNoTestsReason(check.command);
    if (none) errors.push({ code:"verification_pass_with_no_tests", message:`verification[${index}] command "${check.command}" ${none}; remove the flag and name the test file or folder exactly, so a wrong filter fails the check` });
  }
  // A check that only tests the existence of files the base already has is green before the work: it proves nothing.
  if (kinds && !isMainfixTask(task.id)) {
    const present = (path:string, cwd:string) => { const kind = kindOf(resolve(cwd, path)); return kind === "file" || kind === "directory"; };
    const vacuous = task.verification.flatMap((check, index) => {
      const paths = existenceOnlyPaths(check.command);
      return paths && paths.every((path) => present(path, check.cwd)) ? [{ index, check, paths }] : [];
    });
    const allVacuous = vacuous.length === task.verification.length && vacuous.length > 0;
    for (const { index, check, paths } of vacuous) {
      const finding = { code:"verification_existence_on_base", message:`verification[${index}] command "${check.command}" only tests that ${paths.join(", ")} exists, and it already exists on the base commit, so it passes before the work; test a new file, grep -q for the expected string, or run a test that fails now` };
      if (allVacuous && task.risk !== "low" && !NO_RED_KINDS.includes(task.kind ?? "")) errors.push(finding); else warnings.push(finding);
    }
  }
  if ((task.risk !== "low" || task.kind === "fix") && task.verification.length > 0 && kinds && !isMainfixTask(task.id) && !errors.some((error) => error.code === "verification_empty_check")
    && !checkNamedPaths(task).some((path) => kindOf(path) === "missing")) {
    const closes = task.kind === "fix" || task.kind === "check";
    warnings.push({ code:"no_red_before_green", message:`risk ${task.risk}${task.kind ? `, kind ${task.kind}` : ""}: no verification command names a file that is missing on the base commit, so every check may already pass before the work. ${closes ? `If they do, a ${task.kind} closes accepted without a writer. If the bug is still there, add a check that reproduces it.` : "If they do, the attempt does not start: green checks do not tell done from not done. Add a check that is red now."} This is a warning: the task goes on` });
  }

  // Checks: a folder filter ends in «/», and a whole-suite vitest run excludes what the sandbox cannot run.
  for (const filter of folderFilters(task)) {
    if (kindOf(filter.path) === "directory") {
      errors.push({ code:"filter_folder_slash", message:`verification[${filter.index}] filters by the folder ${filter.arg} without a trailing slash, which the runner reads as a text match and so also runs ${filter.arg}-*.test.ts and the like; write ${filter.arg}/` });
    }
  }
  for (const check of task.verification) {
    // With a gate, a task's check is its own files: the whole suite is the gate's, once per batch (so no exclusions to add either).
    // Two filtered calls of the same runner (`--filter A && --filter B`) are the suite twice; one filter is enough.
    const again = input.gate ? repeatedRunner(check.command) : null;
    if (input.gate && again && !runsWholeSuite(check.command) && !runsGateCommand(check.command, input.gate.command)) {
      errors.push({ code:"repeated_runner_chain", message:`verification command "${check.command}" runs ${again} more than once in one check; one filtered run is enough, the integration gate (${input.gate.command}) runs the whole suite once per batch`,
        data:{ gateCommand:input.gate.command, runner:again } });
      continue;
    }
    if (input.gate && (runsWholeSuite(check.command) || runsGateCommand(check.command, input.gate.command))) {
      errors.push({ code:"whole_suite_with_gate", message:`verification command "${check.command}" runs the whole test suite; the integration gate (${input.gate.command}) runs the whole suite once per batch, so check only this task's files, e.g. npx vitest run <its test files>, plus the typecheck`,
        data:{ gateCommand:input.gate.command } });
      continue;
    }
    const missing = findSandboxUnsafeMissingExcludes(check.command, input.sandboxUnsafe);
    if (!missing.length) continue;
    const suggestedFlags = missing.map((pattern) => `--exclude "${pattern}"`).join(" ");
    errors.push({ code:"sandbox_unsafe", message:`verification command "${check.command}" runs a full test suite without excluding sandbox-unsafe tests; add missing exclusions: ${suggestedFlags}`,
      data:{ missingExcludes:missing, suggestedFlags } });
  }

  // A check that has outrun its limit in this project fails whatever the writer does: the recorded timeouts and green runs say how long it needs.
  // (Vampirism Fire 2026-10-26: wc35ef88c-T1 ran the whole Studio suite, 5–10 min, with no timeout_sec: killed at 120 s five times.)
  for (const [index, check] of task.verification.entries()) {
    const history = input.checkHistory?.(check);
    if (!history) continue;
    const limit = check.timeout_sec ?? DEFAULT_CHECK_TIMEOUT_SEC;
    const timedOut = Math.max(0, ...history.timedOutSec);
    const green = history.greenMs.length >= CHECK_HISTORY_MIN_RUNS ? Math.ceil(p95(history.greenMs) / 1000) : 0;
    const limitText = check.timeout_sec ? `timeout_sec ${limit}` : `no timeout_sec (the default is ${DEFAULT_CHECK_TIMEOUT_SEC} s)`;
    // The timed-out run says only «longer than its limit»: 5× that; the green runs say how long it takes: twice the p95, as the check's own widening does.
    const needed = Math.min(7200, Math.ceil(Math.max(limit <= timedOut ? timedOut * 5 : 0, limit < green ? green * 2 : 0) / 60) * 60);
    if (limit <= timedOut) {
      errors.push({ code:"verification_timeout", message:`verification[${index}] command "${check.command}" timed out in this project at ${timedOut} s (${history.timedOutSec.length} attempt${history.timedOutSec.length > 1 ? "s" : ""}) and this contract has ${limitText}, so it is killed again whatever the writer does; set timeout_sec to ${needed} or more${green ? ` (its green runs take up to ${green} s)` : ""}, or narrow the command to this task's tests` });
    } else if (limit < green) {
      errors.push({ code:"verification_timeout", message:`verification[${index}] command "${check.command}" took up to ${green} s in its last ${history.greenMs.length} green runs in this project and this contract has ${limitText}; set timeout_sec to ${needed} or more, or narrow the command to this task's tests` });
    }
  }

  // Secrets a check declares: a valid name, left open by the project list, of a kind a check can take, and in Env Catalog.
  // A name that is simply not saved yet is a warning: the task waits for it (waiting_secret) and starts once it is.
  const declared = [...new Set(task.verification.flatMap((check) => check.secrets ?? []))];
  const reserved = declared.filter((name) => SANDBOX_OWN_ENV.has(name));
  for (const name of reserved) errors.push({ code:"secret_reserved", message:`verification secrets names ${name}, which the sandbox sets itself; pick another name in Env Catalog` });
  const found = input.secrets;
  if (found && declared.length) {
    if (found.unavailable) {
      errors.push({ code:"secret_catalog_unavailable", message:`verification declares secrets (${declared.join(", ")}) but Env Catalog is not installed or not answering, so no check can receive them; install and enable the env-catalog plugin, or drop secrets from the checks` });
    } else {
      // The project list only narrows: a non-empty «Secrets checks may use» (secrets.allow) that leaves a name out stops it.
      if (found.denied.length) errors.push({ code:"secret_not_allowed", data:{ deniedSecrets:found.denied },
        message:`verification secrets ${found.denied.join(", ")} are left out of the project list «Secrets checks may use» (secrets.allow); add the name to the list (or empty the list, then every declared name is allowed), then send the task again` });
      if (found.wrongKind.length) errors.push({ code:"secret_kind", message:`verification secrets ${found.wrongKind.join(", ")} are SSH or FTP access, which a check cannot take; a deploy step that needs them goes to lane_pilot_errand` });
      for (const name of found.missing.filter((missing) => !reserved.includes(missing))) {
        const near = found.catalog ? nearSecretName(name, found.catalog) : null;
        if (near) errors.push({ code:"secret_name_unknown", message:`verification secrets ${name} is not in Env Catalog; did you mean ${near}? use the exact name` });
        else warnings.push({ code:"secret_missing", message:`verification secrets ${name} is not in Env Catalog yet: call env_request for it now (name ${name}, with a purpose); the task waits (waiting_secret:${name}) and starts by itself once the owner saves it` });
      }
    }
  }

  // depends_on a task that already ended blocked or canceled: the PM replans before this one is queued (a loop or a self reference is the plan critique's).
  for (const dead of input.deadDependencies) {
    errors.push({ code:"depends_dead", data:{ replan:true }, message:dead.state === "blocked"
      ? `replan: depends_on ${dead.id} ended blocked, so this task would never start; send ${dead.id} again (fixed) first and then this task, which waits for it, or drop ${dead.id} from depends_on if the task does not need its files`
      : `replan: depends_on ${dead.id} ended canceled, so this task would never start; drop it from depends_on or dispatch ${dead.id} again first` });
  }

  // Overlapping an open task is allowed: the later task waits for the earlier one, so it is a note.
  for (const open of input.openTasks) {
    if (open.id !== task.id && ownsPathsOverlap(task.owns_paths, open.owns_paths) && !task.depends_on.includes(open.id)) {
      warnings.push({ code:"owns_overlap_open", message:`owns_paths overlap the open task ${open.id}; this task waits for it and runs after it, not beside it` });
    }
  }
  return { errors, warnings };
}

/** The one message that goes back to the PM: every problem with its fix, nothing created. */
export function lintReply(runId:string, errors:readonly LintFinding[]):Record<string, unknown> {
  const data = Object.assign({}, ...[...errors].reverse().map((error) => error.data ?? {})) as Record<string, unknown>;
  return { runId, state:"validation_failed", ...data,
    reason:`contract lint: nothing was dispatched and no attempt was spent. Fix and send the task again:\n${errors.map((error) => `- ${error.message}`).join("\n")}`,
    findings:errors.map(({ code, message }) => ({ code, message, blockingClass:blockingClass(code) })),
    // Three blocking classes: what is missing, what must come first, what is in the way.
    blockingClasses:[...new Set(errors.map((error) => blockingClass(error.code)).filter(Boolean))] };
}
