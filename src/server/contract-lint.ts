import { resolve } from "node:path";
import type { TaskV2 } from "../contracts";
import { fileAllowedByOwns, fileBlockedByNeverTouch, matchOwnsPath, ownsPathsOverlap } from "../owns-paths";
import { findSandboxUnsafeMissingExcludes, runnerFilterArgs, runsWholeSuite } from "../stages/critique-coverage";
import { parseReadFirstHints } from "../stages/read-first";
import { SUBJECTIVE_WORDS } from "../stages/role-method";
import { isOutputPath, unownedExpectedOutputs } from "../validate-output";
import { SANDBOX_OWN_ENV } from "../verification/sandbox";
import type { CatalogEntry, SecretCheck } from "./secrets";
import { safeRelative, validateOwnershipContract } from "../verification/ownership";

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

/** Absolute paths whose kind the workspace's machine must report: the read_first files and the bare words of check filters. */
export function lintProbePaths(task:TaskV2, workspacePath:string):string[] {
  let hints:string[] = [];
  try { hints = parseReadFirstHints(task.read_first).map((hint) => resolve(workspacePath, hint.path)); } catch { /* reported by lintContract */ }
  return [...new Set([...hints, ...folderFilters(task).map((filter) => filter.path)])].slice(0, MAX_PROBES);
}

/** Everything a task contract gets wrong before any helper or writer runs; errors send the task back to the PM, warnings go along with the answer. */
export function lintContract(input:LintInput):{ errors:LintFinding[]; warnings:LintFinding[] } {
  const { task, kinds } = input;
  const errors:LintFinding[] = [], warnings:LintFinding[] = [];
  const kindOf = (path:string) => kinds?.get(path);

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
  if (!errors.some((error) => error.code === "ownership_unsafe")) {
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
