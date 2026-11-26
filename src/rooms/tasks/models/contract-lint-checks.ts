import { acceptanceCommandFindings, birthFindings, birthGates, blockingClass, checkProgram, ownerWordFindings } from "./rails";
import { dirnamePath, resolvePath } from "./path-utils";
import { TASK_KINDS, type TaskV2 } from "../../contracts";
import { fileAllowedByOwns, fileBlockedByNeverTouch, matchOwnsPath, ownsPathsOverlap } from "@lane-pilot/kit";
import { findSandboxUnsafeMissingExcludes, runnerFilterArgs, runsWholeSuite } from "../../contracts/check-commands";
import { NO_RED_KINDS } from "../../contracts";
import { readFirstFindings, readFirstProbePaths } from "./read-first-lint";
import { maskedExitReason, needsCommitReason, passWithNoTestsReason } from "./lint-exit-status";
import { SUBJECTIVE_WORDS } from "../../contracts/review-vocabulary";
import { browserQaRequired } from "../../contracts/quality-mode";
import type { QualityMode } from "../../contracts/quality-mode";
import { isMainfixTask, isOutputPath, unownedExpectedOutputs } from "./validate-output";
import { mapVerificationCwd } from "./verification-cwd";
import { SANDBOX_OWN_ENV } from "../../contracts";
import { gluedCheckCommand } from "../../contracts/check-commands";
import type { CatalogEntry, SecretCheck } from "../../secrets";
import { safeRelative, validateOwnershipContract } from "../../contracts/ownership";
import { CHECK_HISTORY_MIN_RUNS, p95 } from "./check-history";
import { dependsLoopFindings } from "./depends-lint";

/** One problem in a task contract, with the concrete fix; `data` rides along in the answer to the PM. */
export type LintFinding = { code:string; message:string; data?:Record<string, unknown> };
export type PathKind = "missing" | "file" | "directory" | "symlink" | "other";
export type LintOpenTask = { id:string; owns_paths:string[]; never_touch:string[]; depends_on:string[] };
export type LintInput = {
  task:TaskV2;
  workspacePath:string;
  /** Repository root verified on the workspace host, only for explicit repo: reads. */
  repoRootPath?:string|null;
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
  /** How the task was born (SMA: the birth kind chooses the gates); absent reads as a PM's dispatch. `redoneBirth` is the birth a redo redoes. */
  birth?:string;
  redoneBirth?:string | null;
  /** The confirmed phase drawings of the task's run (SMA: service drawing kinship), each with the sha256 recomputed over the files now. */
  confirmedDrawings?:ReadonlyArray<{ paths:readonly string[]; sha256:string; /** A file of it no longer matches the hash the design stage confirmed. */ changed?:boolean }>;
  /** Other open tasks of the project. */
  openTasks:readonly LintOpenTask[];
  /** The other open tasks of this task's run with their depends_on (absent: not asked, the cycle rule stays silent). */
  runTasks?:ReadonlyArray<{ id:string; depends_on:readonly string[] }>;
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

/** Which test runner one `&&` / `;` step starts, or null. A `cd`, a typecheck or a syntax check (`bash -n`, `node --check`, `php -l`) is not a runner. */
function runnerOf(segment:string):string | null {
  // A step that only checks syntax is not a run of the suite; without this `bash -n x.sh && bash x.sh` read as two runs.
  if (/^\s*(?:cd\s+\S+\s*&&\s*)?(?:sudo\s+-n\s+)?(?:bash|sh|node|python3?|php|ruby)\s+(?:-[a-zA-Z]*n|--check|--syntax-check|-l|-m\s+py_compile)\s+['"]?\S+['"]?\s*$/.test(segment)) return null;
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

export const folderFilters = (task:TaskV2) => task.verification.flatMap((check, index) =>
  runnerFilterArgs(check.command).filter((arg) => !arg.endsWith("/")).map((arg) => ({ index, command:check.command, arg, path:resolvePath(check.cwd, arg) })));

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
    if (token.includes("/") || /\.[A-Za-z0-9]{1,6}$/.test(token)) found.add(resolvePath(check.cwd, token));
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
  const folders = ownedCodeFiles(task).flatMap(({ dir }) => [resolvePath(workspacePath, dir || "."), resolvePath(workspacePath, `${dir}__tests__`)]);
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
    const here = listings.get(resolvePath(workspacePath, dir || ".")) ?? [];
    const codeStems = here.filter((name) => CODE_NAME.test(name) && !TEST_NAME.test(name)).map(stemOf);
    for (const [where, names] of [[dir, here], [`${dir}__tests__/`, listings.get(resolvePath(workspacePath, `${dir}__tests__`)) ?? []]] as const) {
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
export function concreteFile(path:string):string | null {
  const norm = path.replace(/^\.\//, "").replace(/\/$/, "");
  if (!norm || /[*?[]/.test(norm) || !/(?:^|\/)[^/]*\.[A-Za-z0-9]{1,8}$/.test(norm)) return null;
  return norm;
}

/** The task creates the file: it is an expected output, or files[] says create. */
export function taskCreatesFile(task:Pick<TaskV2, "expected_outputs" | "files">, path:string):boolean {
  if (task.expected_outputs.some((entry) => entry.replace(/^\.\//, "") === path)) return true;
  return (task.files ?? []).some((file) => file.action === "create" && file.path.replace(/^\.\//, "") === path);
}

/** Absolute paths whose kind the workspace's machine must report: the read_first files, the bare words of check filters, the tests next to owned files, and the concrete files the contract names. */
export function lintProbePaths(task:TaskV2, workspacePath:string, repoRootPath?:string|null):string[] {
  const hints = readFirstProbePaths(task, workspacePath, repoRootPath);
  const tests = siblingTestCandidates(task).map((candidate) => resolvePath(workspacePath, candidate.folder ?? candidate.test));
  const named = [...task.owns_paths, ...task.expected_outputs, ...(task.files ?? []).map((file) => file.path)]
    .map(concreteFile).filter((path):path is string => !!path)
    .flatMap((path) => {
      const dir = dirnamePath(path);
      return dir === "." ? [resolvePath(workspacePath, path)] : [resolvePath(workspacePath, path), resolvePath(workspacePath, dir)];
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

/** Everything a contract gets wrong before any helper or writer runs: check-command and file-probe helpers live here, lintContract composes them. */
export { DEFAULT_CHECK_TIMEOUT_SEC, acceptanceCommandFindings, birthFindings, birthGates, blockingClass, checkProgram, dependsLoopFindings, gluedCheckCommand, isMainfixTask, isOutputPath, mapVerificationCwd, maskedExitReason, matchOwnsPath, needsCommitReason, ownerWordFindings, ownsPathsOverlap, passWithNoTestsReason, readFirstFindings, findSandboxUnsafeMissingExcludes, runsWholeSuite, safeRelative, unownedExpectedOutputs, validateOwnershipContract, browserQaRequired, fileAllowedByOwns, fileBlockedByNeverTouch, SANDBOX_OWN_ENV, NO_RED_KINDS, CHECK_HISTORY_MIN_RUNS, p95 };
