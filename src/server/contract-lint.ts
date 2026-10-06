import { resolve } from "node:path";
import type { TaskV2 } from "../contracts";
import { fileBlockedByNeverTouch, matchOwnsPath, ownsPathsOverlap } from "../owns-paths";
import { findSandboxUnsafeMissingExcludes } from "../stages/critique-coverage";
import { parseReadFirstHints } from "../stages/read-first";
import { isOutputPath, unownedExpectedOutputs } from "../validate-output";
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
  /** Other open tasks of the project. */
  openTasks:readonly LintOpenTask[];
  /** depends_on names whose latest task ended blocked or canceled and that nothing restarts or vouches for. */
  deadDependencies:readonly { id:string; state:"blocked" | "canceled" }[];
};

/** Flags of vitest/jest that take a value: that value is not a test filter. */
const VALUE_FLAGS = new Set(["--exclude", "-x", "--config", "-c", "--root", "-r", "--reporter", "--project", "--dir", "--environment", "--testNamePattern", "-t", "--outputFile", "--shard"]);
const MAX_PROBES = 128;

/** Positional arguments a vitest/jest run, or an npm/pnpm/yarn script after «--», receives. */
export function runnerFilterArgs(command:string):string[] {
  const found:string[] = [];
  for (const part of command.split(/&&|;|\|\|/)) {
    const tokens = part.trim().split(/\s+/);
    let from = tokens.findIndex((token) => /(?:^|\/)(?:vitest|jest)$/.test(token));
    if (from < 0 && /^(?:npm|pnpm|yarn)$/.test(tokens[0] ?? "")) from = tokens.indexOf("--");
    if (from < 0) continue;
    for (let i = from + 1; i < tokens.length; i++) {
      const token = tokens[i]!.replace(/^["']|["']$/g, "");
      if (VALUE_FLAGS.has(token)) { i++; continue; }
      if (/^[\w@.][\w@./-]*$/.test(token) && !token.startsWith("--")) found.push(token);
    }
  }
  return found;
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

  // Checks: a folder filter ends in «/», and a whole-suite vitest run excludes what the sandbox cannot run.
  for (const filter of folderFilters(task)) {
    if (kindOf(filter.path) === "directory") {
      errors.push({ code:"filter_folder_slash", message:`verification[${filter.index}] filters by the folder ${filter.arg} without a trailing slash, which the runner reads as a text match and so also runs ${filter.arg}-*.test.ts and the like; write ${filter.arg}/` });
    }
  }
  for (const check of task.verification) {
    const missing = findSandboxUnsafeMissingExcludes(check.command, input.sandboxUnsafe);
    if (!missing.length) continue;
    const suggestedFlags = missing.map((pattern) => `--exclude "${pattern}"`).join(" ");
    errors.push({ code:"sandbox_unsafe", message:`verification command "${check.command}" runs a full test suite without excluding sandbox-unsafe tests; add missing exclusions: ${suggestedFlags}`,
      data:{ missingExcludes:missing, suggestedFlags } });
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
