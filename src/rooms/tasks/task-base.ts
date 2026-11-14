import { isAbsolute, posix, relative, resolve } from "node:path";
import { ownsPathsOverlap } from "@lane-pilot/kit";
import type { TaskV2 } from "../contracts";
import { isOutputPath } from "./validate-output";
import { applyTrustedTooling } from "./trusted-tooling";

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
    // The repository's own root is where hooks, CI and .claude live now, so the trusted tooling is added again relative to it.
    task: applyTrustedTooling({ ...task, project_cwd: base, owns_paths: owns, expected_outputs: outputs, never_touch: never, read_first: reads,
      verification: task.verification.map((check) => ({ ...check, cwd: resolve(task.project_cwd, check.cwd) })) }),
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

/**
 * Whether two tasks can touch the same files, each owns_paths read in its own checkout (taskBasePath): one checkout compares
 * them as written, nested checkouts from the outer one, sibling repositories never. Every queue, wait and overlap note goes
 * through here: comparing raw owns_paths across a BB project told MyPosts' PM its tasks waited for Lane Pilot's
 * `integrate-origin-main-b` (owns `**`), and the PM chased the other chat to cancel it (2026-11-05).
 */
export function checkoutOwnsOverlap(baseA: string | null, ownsA: readonly string[], baseB: string | null, ownsB: readonly string[]): boolean {
  if (!baseA || !baseB || resolve(baseA) === resolve(baseB)) return ownsPathsOverlap([...ownsA], [...ownsB]);
  const pair = ownsFromOuterBase(baseA, ownsA, baseB, ownsB);
  return Boolean(pair && ownsPathsOverlap(pair[0], pair[1]));
}

/** Whether a stored contract belongs to the run: its checkout is the run's folder or inside it, or (repo_scope) the repository root above it. */
export function taskInRunScope(runFolder: string, task: Pick<TaskV2, "project_cwd" | "repo_scope">): boolean {
  return isTaskBase(runFolder, task.project_cwd)
    || (task.repo_scope === true && resolve(task.project_cwd) !== resolve(runFolder) && isTaskBase(task.project_cwd, runFolder));
}

/**
 * Asked on the run folder's own host: the top of the repository above it and the folder's real path. Section chats of one
 * monorepo run in a subfolder; the task of such a chat may change files elsewhere in the same repository (never in another one).
 */
export function repoRootCommand(runFolder: string): string {
  return `cd ${quote(runFolder)} && git rev-parse --show-toplevel && pwd -P`;
}

/**
 * The repository root as a path from the run folder as it is written there (`..`, `../..`) and the folder's place in the
 * repository (`aiphoto_bot`); null when the folder is the root itself, has no repository, or the answer is not an ancestor.
 */
export function parseRepoRoot(ran: { exitCode: number; stdout: string } | null): { up: string; prefix: string } | null {
  if (!ran || ran.exitCode !== 0) return null;
  const [top, runReal] = ran.stdout.trim().split("\n").map((line) => line.trim());
  if (!top || !runReal) return null;
  const prefix = relative(top, runReal).split("\\").join("/");
  if (!prefix || prefix.startsWith("..") || isAbsolute(prefix)) return null;
  return { up: relative(runReal, top).split("\\").join("/"), prefix };
}

/** A path of the section as a path of the repository root; null when it leaves the repository (or is no relative path). */
function rootRelative(path: string, prefix: string): string | null {
  if (path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) return null;
  const joined = posix.normalize(`${prefix}/${path.replace(/^\.\//, "")}`);
  if (joined === ".." || joined.startsWith("../") || joined === ".") return null;
  return path.endsWith("/") && !joined.endsWith("/") ? `${joined}/` : joined;
}

/** Whether a section-relative path pattern climbs out of the section (`../sdk/x.ts`). */
export function leavesSection(path: string): boolean {
  const normalized = posix.normalize(path.replace(/^\.\//, ""));
  return normalized === ".." || normalized.startsWith("../");
}

/**
 * The task moved up to the root of the repository holding its section: every path relative to the section becomes a path
 * relative to the root (`../sdk/x.ts` -> `sdk/x.ts`, `src/a.ts` -> `aiphoto_bot/src/a.ts`), so ownership, dirt, the diff, test_fit
 * and the merge all see the files they must, and nothing there reads a `..`. The checks keep their absolute folders (the
 * section's). `outside` names the owned paths and outputs outside the section. Null when a path leaves the repository or a
 * check runs outside it: that task stays as written and the contract lint refuses it as before.
 */
export function rerootToRepoRoot(task: TaskV2, root: string, prefix: string): { task: TaskV2; outside: string[] } | null {
  const map = (paths: readonly string[]): string[] | null => {
    const out: string[] = [];
    for (const path of paths) { const rooted = rootRelative(path, prefix); if (rooted === null) return null; out.push(rooted); }
    return out;
  };
  const owns = map(task.owns_paths);
  const never = map(task.never_touch);
  const reads = map(task.read_first);
  const removals = map(task.test_removals ?? []);
  const drawing = map(task.drawing ?? []);
  if (!owns || !never || !reads || !removals || !drawing) return null;
  const outputs: string[] = [];
  const outputPaths: string[] = [];
  for (const output of task.expected_outputs) {
    if (!isOutputPath(output)) { outputs.push(output); continue; }
    const rooted = rootRelative(output, prefix);
    if (rooted === null) return null;
    outputs.push(rooted);
    outputPaths.push(rooted);
  }
  const files = task.files ? task.files.map((file) => ({ ...file, path: rootRelative(file.path, prefix) })) : undefined;
  if (files?.some((file) => file.path === null)) return null;
  for (const check of task.verification) if (!isTaskBase(root, resolve(task.project_cwd, check.cwd))) return null;
  const outside = [...new Set([...owns, ...outputPaths].filter((path) => path !== prefix && !path.startsWith(`${prefix}/`)))];
  const { test_removals: _a, drawing: _b, files: _c, ...rest } = task;
  return {
    task: applyTrustedTooling({
      ...rest, project_cwd: resolve(root), repo_scope: true, owns_paths: owns, never_touch: never, read_first: reads, expected_outputs: outputs,
      ...(task.test_removals ? { test_removals: removals } : {}), ...(task.drawing ? { drawing } : {}), ...(files ? { files: files as NonNullable<TaskV2["files"]> } : {}),
      verification: task.verification.map((check) => ({ ...check, cwd: resolve(task.project_cwd, check.cwd) })),
    }),
    outside,
  };
}

/** The plan with what the writer needs to know about its place: the root, the section, what lies outside it. */
export function planWithRepoScope(plan: string, root: string, prefix: string, outside: readonly string[]): string {
  return `${plan}\n\nWhere you work: this task was started from the section ${prefix}/ of the repository ${root}, and it also changes files outside that section, so your folder is the repository root and every path of the contract is relative to it (the section is ${prefix}/). Its checks run in the section's folder as written. Outside the section you may change only: ${outside.join(", ")}. Other sections and bots of the repository stay as they are.\n`;
}
