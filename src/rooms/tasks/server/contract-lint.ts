import { resolve } from "node:path";
import { TASK_KINDS, type TaskV2 } from "../../contracts";
import { fileAllowedByOwns, fileBlockedByNeverTouch, matchOwnsPath, ownsPathsOverlap } from "@lane-pilot/kit";
import { findSandboxUnsafeMissingExcludes, runnerFilterArgs, runsWholeSuite } from "../../critique";
import { NO_RED_KINDS } from "../../baseline";
import { parseReadFirstHints } from "../read-first";
import { maskedExitReason, passWithNoTestsReason } from "./lint-exit-status";
import { SUBJECTIVE_WORDS } from "../../critique";
import { isMainfixTask, isOutputPath, unownedExpectedOutputs } from "../validate-output";
import { mapVerificationCwd } from "../verification-cwd";
import { SANDBOX_OWN_ENV } from "../../verification";
import type { CatalogEntry, SecretCheck } from "../../secrets/server";
import { safeRelative, validateOwnershipContract } from "../../verification";

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
  sandboxUnsafe:readonly string[];
  /** The project's integration gate (explicit or detected) runs the whole suite once per batch; absent or null when there is none. */
  gate?:{ command:string } | null;
  /** Other open tasks of the project. */
  openTasks:readonly LintOpenTask[];
  /** depends_on names whose latest task ended blocked or canceled and that nothing restarts or vouches for. */
  deadDependencies:readonly { id:string; state:"blocked" | "canceled" }[];
  /** Env Catalog's answer for the secrets the checks declare (J2); absent when none is declared. */
  secrets?:SecretCheck & { catalog:readonly CatalogEntry[] | null };
};

export { runnerFilterArgs };

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

/** Absolute paths whose kind the workspace's machine must report: the read_first files, the bare words of check filters, the tests next to owned files. */
export function lintProbePaths(task:TaskV2, workspacePath:string):string[] {
  let hints:string[] = [];
  try { hints = parseReadFirstHints(task.read_first).map((hint) => resolve(workspacePath, hint.path)); } catch { /* reported by lintContract */ }
  const tests = siblingTestCandidates(task).map((candidate) => resolve(workspacePath, candidate.folder ?? candidate.test));
  return [...new Set([...hints, ...folderFilters(task).map((filter) => filter.path), ...tests, ...checkNamedPaths(task)])].slice(0, MAX_PROBES);
}

export const DISPLAY_TITLE_MAX = 60;

/**
 * The task standard the Tasks board shows from: a card title in the owner's language, a kind and an area. Lane Pilot's own tasks
 * (mainfix, workflow chains) fill the three themselves, so only a PM's contract is ever refused here.
 */
export function taskStandardFindings(task:Pick<TaskV2, "display_title" | "kind" | "area">):LintFinding[] {
  const found:LintFinding[] = [];
  const title = task.display_title?.trim() ?? "";
  if (!title) found.push({ code:"display_title_missing", message:"display_title is missing: add the card title for the Tasks board, in the language the owner writes in, at most 60 characters, what changes for a person, no ids or paths (for a Russian-speaking owner: \"Страница заказов в кабинете\")" });
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
  const flagged = new Set<string>();
  for (const candidate of siblingTestCandidates(task)) {
    const present = candidate.folder ? kindOf(resolve(input.workspacePath, candidate.folder)) === "directory" : kindOf(resolve(input.workspacePath, candidate.test)) === "file";
    if (!present || flagged.has(candidate.test) || flagged.size >= 5) continue;
    if (fileAllowedByOwns(candidate.test, task.owns_paths) || fileBlockedByNeverTouch(candidate.test, task.never_touch)) continue;
    flagged.add(candidate.test);
    errors.push({ code:"test_unowned", message:`owns_paths ${candidate.owned} has ${candidate.folder ? "tests in" : "its test"} ${candidate.folder ?? candidate.test} outside owns_paths; the writer updates the tests of the code it changes and an edit there rejects the attempt, so add ${candidate.test} to owns_paths, or to never_touch if the writer must leave it as it is` });
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
  if (task.risk !== "low" && task.verification.length > 0 && kinds && !isMainfixTask(task.id) && !errors.some((error) => error.code === "verification_empty_check")
    && !checkNamedPaths(task).some((path) => kindOf(path) === "missing")) {
    warnings.push({ code:"no_red_before_green", message:`risk ${task.risk}: no verification command names a file that is missing on the base commit, so every check may already pass before the work; add one that fails until the task is done (a test for the new behaviour in a file the task creates, grep -q for the expected string, test -f on a new output). This is a warning: the task goes on` });
  }

  // Checks: a folder filter ends in «/», and a whole-suite vitest run excludes what the sandbox cannot run.
  for (const filter of folderFilters(task)) {
    if (kindOf(filter.path) === "directory") {
      errors.push({ code:"filter_folder_slash", message:`verification[${filter.index}] filters by the folder ${filter.arg} without a trailing slash, which the runner reads as a text match and so also runs ${filter.arg}-*.test.ts and the like; write ${filter.arg}/` });
    }
  }
  for (const check of task.verification) {
    // With a gate, a task's check is its own files: the whole suite is the gate's, once per batch (so no exclusions to add either).
    if (input.gate && runsWholeSuite(check.command)) {
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
    findings:errors.map(({ code, message }) => ({ code, message })) };
}
