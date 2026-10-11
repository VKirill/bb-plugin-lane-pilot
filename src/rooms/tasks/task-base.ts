import { isAbsolute, relative, resolve } from "node:path";
import type { TaskV2 } from "../contracts";
import { isOutputPath } from "./validate-output";

/**
 * A task's base is the checkout it works in: the run's folder, or a git repository inside it. A run folder without git that
 * holds repositories (BB-сервис: 41 plugin repositories) gives a task whose files all sit in one of them that repository:
 * its own worktree, its own git diff and a merge into its main, instead of the live folder (2026-10-10: 11 of 14 failed).
 */
export function isTaskBase(runFolder: string, base: string): boolean {
  const rel = relative(resolve(runFolder), resolve(base));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const pathParts = (path: string) => path.replaceAll("\\", "/").replace(/^\.\//, "").split("/").filter(Boolean);

/** The part of a path pattern before its first wildcard, as folders: `plugins/a/src/**` → plugins, a, src. */
function literalParts(pattern: string): string[] {
  const parts: string[] = [];
  for (const part of pathParts(pattern)) {
    if (/[*?[]/.test(part)) break;
    parts.push(part);
  }
  return parts;
}

/**
 * The deepest folder every path of the task lies in, relative to project_cwd: owns_paths, the expected outputs that are
 * paths, and the folders of the checks. Null when they share none (a task over the whole folder or two repositories).
 */
export function commonTaskFolder(task: Pick<TaskV2, "project_cwd" | "owns_paths" | "expected_outputs" | "verification">): string | null {
  const lists: string[][] = [];
  for (const pattern of task.owns_paths) lists.push(literalParts(pattern));
  for (const output of task.expected_outputs) if (isOutputPath(output)) lists.push(pathParts(output).slice(0, -1));
  for (const check of task.verification) {
    const rel = relative(resolve(task.project_cwd), resolve(task.project_cwd, check.cwd));
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    lists.push(pathParts(rel));
  }
  if (!task.owns_paths.length) return null;
  const common: string[] = [];
  for (let index = 0; ; index++) {
    const part = lists[0]?.[index];
    // A pattern that names a file («plugins/a/README.md») still has its folder in common with the others.
    if (part === undefined || lists.some((parts) => parts[index] !== part)) break;
    common.push(part);
  }
  return common.length ? common.join("/") : null;
}

/** Under `prefix` (a folder relative to the old project_cwd): the rest of the path, or null outside it. */
function under(path: string, prefix: string): string | null {
  const clean = path.replace(/^\.\//, "");
  if (clean === prefix) return "";
  return clean.startsWith(`${prefix}/`) ? clean.slice(prefix.length + 1) : null;
}

/**
 * The task moved into the repository `prefix` of its run folder: paths become relative to the repository, never_touch
 * outside it is dropped (nothing outside is in the repository's worktree), and read_first files outside it come back as
 * absolute paths for the plan (read_first takes project paths only). Null when an owned path, an expected output or a
 * check lies outside the repository.
 */
export function rerootTask(task: TaskV2, prefix: string): { task: TaskV2; outsideReads: string[] } | null {
  const base = resolve(task.project_cwd, prefix);
  const owns: string[] = [];
  for (const pattern of task.owns_paths) {
    const rest = under(pattern, prefix);
    if (rest === null || rest === "") return null;
    owns.push(rest);
  }
  const outputs: string[] = [];
  for (const output of task.expected_outputs) {
    if (!isOutputPath(output)) { outputs.push(output); continue; }
    const rest = under(output, prefix);
    if (rest === null || rest === "") return null;
    outputs.push(rest);
  }
  for (const check of task.verification) if (!isTaskBase(base, resolve(task.project_cwd, check.cwd))) return null;
  const reads: string[] = [];
  const outsideReads: string[] = [];
  for (const hint of task.read_first) {
    const rest = under(hint, prefix);
    if (rest) reads.push(rest);
    else outsideReads.push(resolve(task.project_cwd, hint.replace(/^\.\//, "")));
  }
  const never = task.never_touch.flatMap((pattern) => {
    const rest = under(pattern, prefix);
    return rest ? [rest] : [];
  });
  return {
    task: { ...task, project_cwd: base, owns_paths: owns, expected_outputs: outputs, never_touch: never, read_first: reads,
      verification: task.verification.map((check) => ({ ...check, cwd: resolve(task.project_cwd, check.cwd) })) },
    outsideReads,
  };
}

/** The plan with the reference files the task names outside its repository, by absolute path. */
export function planWithOutsideReads(plan: string, outsideReads: readonly string[]): string {
  if (!outsideReads.length) return plan;
  return `${plan}\n\nAlso read before you start (reference files outside this repository, by absolute path; do not edit them):\n${outsideReads.map((path) => `- ${path}`).join("\n")}\n`;
}

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * Asked on the folder's own host: the top of the git repository holding `folder` (its nearest existing parent, as the
 * task may create it) and the run folder's real path, one per line. git answers real paths (/private/var for /var).
 */
export function repoTopCommand(folder: string, runFolder: string): string {
  return `d=${quote(folder)}; while [ ! -d "$d" ]; do d=$(dirname "$d"); done; cd "$d" && git rev-parse --show-toplevel && cd ${quote(runFolder)} && pwd -P`;
}

/** The repository's folder relative to the run folder from `repoTopCommand`'s answer; null when it is the run folder itself, outside it, or no repository. */
export function parseRepoTop(ran: { exitCode: number; stdout: string } | null): string | null {
  if (!ran || ran.exitCode !== 0) return null;
  const [top, runReal] = ran.stdout.trim().split("\n").map((line) => line.trim());
  if (!top || !runReal) return null;
  const rel = relative(runReal, top);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split("\\").join("/") : null;
}

/**
 * Two tasks' owns_paths from the outer of their two bases (a run folder and a repository inside it), so they can be
 * compared for overlap; null when neither base holds the other.
 */
export function ownsFromOuterBase(baseA: string, ownsA: readonly string[], baseB: string, ownsB: readonly string[]): [string[], string[]] | null {
  const prefixed = (prefix: string, owns: readonly string[]) => owns.map((pattern) => `${prefix}/${pattern.replace(/^\.\//, "")}`);
  const bInA = relative(resolve(baseA), resolve(baseB)).split("\\").join("/");
  if (bInA === "") return [[...ownsA], [...ownsB]];
  if (!bInA.startsWith("..") && !isAbsolute(bInA)) return [[...ownsA], prefixed(bInA, ownsB)];
  const aInB = relative(resolve(baseB), resolve(baseA)).split("\\").join("/");
  if (!aInB.startsWith("..") && !isAbsolute(aInB)) return [prefixed(aInB, ownsA), [...ownsB]];
  return null;
}
