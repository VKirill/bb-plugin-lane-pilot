import { posix } from "node:path";

export type OwnershipTask = {
  project_cwd:string;
  owns_paths:string[];
  never_touch:string[];
  verification:Array<{ cwd:string }>;
};

export type RunOwnershipTask = OwnershipTask & { id:string };

export type RunOwnershipScope =
  | { ok:true; task:OwnershipTask; tasks:OwnershipTask[]; taskIds:string[] }
  | { ok:false; reason:string };

function safeRelative(value:string):string|null {
  if (!value || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return null;
  const normalized = posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  if (normalized.split("/").includes("..")) return null;
  return normalized;
}

function matches(pattern:string, path:string):boolean {
  const normalized = safeRelative(pattern);
  if (!normalized) return false;
  if (normalized.endsWith("/**")) {
    const prefix = normalized.slice(0, -3).replace(/\/$/, "");
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  if (normalized === path) return true;
  // A plain path names that file or everything under it, «apps/bot/__tests__/» included, as in owns-paths.ts.
  // Before, a trailing slash matched nothing: the bot task's own tests were rejected and a never_touch
  // «docs/» guarded nothing (SelfyStudio, 2026-10-02).
  if (!/[*?[]/.test(normalized)) {
    const prefix = normalized.replace(/\/+$/, "");
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  // A single-segment * is supported for path sets such as src/*.ts.
  const expression = normalized.split("/").map((part) => part === "*" ? "[^/]+" :
    part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("/");
  return new RegExp(`^${expression}$`).test(path);
}

export function validateOwnershipContract(task:OwnershipTask):string|null {
  if (!task.owns_paths.length) return "owns_paths must contain at least one project-relative path";
  for (const pattern of [...task.owns_paths, ...task.never_touch]) {
    if (!safeRelative(pattern)) return `unsafe ownership path pattern: ${pattern}`;
  }
  for (const command of task.verification) {
    if (command.cwd !== task.project_cwd && !command.cwd.startsWith(`${task.project_cwd.replace(/\/$/, "")}/`)) {
      return `verification cwd escapes task workspace: ${command.cwd}`;
    }
  }
  return null;
}

/** Build the fail-closed ownership union used when sibling tasks share one run workspace. */
export function resolveRunOwnershipScope(
  tasks:RunOwnershipTask[],
  requestedTaskId:string,
  projectCwd:string,
):RunOwnershipScope {
  if (!tasks.length) return { ok:false, reason:"run scope has no tasks" };
  const ids = new Set<string>();
  const owns = new Set<string>();
  const never = new Set<string>();
  let requestedFound = false;
  for (const task of tasks) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(task.id)) {
      return { ok:false, reason:`run scope has invalid task id: ${task.id}` };
    }
    if (ids.has(task.id)) return { ok:false, reason:`run scope has duplicate task id: ${task.id}` };
    ids.add(task.id);
    if (task.project_cwd !== projectCwd) {
      return { ok:false, reason:`run task ${task.id} project_cwd does not match workspace` };
    }
    const contractError = validateOwnershipContract(task);
    if (contractError) return { ok:false, reason:`run task ${task.id}: ${contractError}` };
    if (task.id === requestedTaskId) requestedFound = true;
    task.owns_paths.forEach((pattern) => owns.add(pattern));
    task.never_touch.forEach((pattern) => never.add(pattern));
  }
  if (!requestedFound) return { ok:false, reason:"requested task is not part of the run task set" };
  return {
    ok:true,
    task:{
      project_cwd:projectCwd,
      owns_paths:[...owns].sort(),
      never_touch:[...never].sort(),
      verification:tasks.find((task) => task.id === requestedTaskId)?.verification ?? [],
    },
    tasks:tasks.map((task) => ({ project_cwd:projectCwd, owns_paths:task.owns_paths, never_touch:task.never_touch, verification:task.verification })),
    taskIds:[...ids].sort(),
  };
}

/** The receipt check-owns-paths writes for a task; running the check is not a change of the writer's. */
const OWNS_CHECK_RECEIPT = /^\.agents\/runs\/[^/]+\/artifacts\/[^/]+\/owns-check\.json$/;

export function findUnownedChanges(changedPaths:string[], task:OwnershipTask):string[] {
  const unowned:string[] = [];
  for (const rawPath of changedPaths) {
    const path = safeRelative(rawPath);
    if (path && OWNS_CHECK_RECEIPT.test(path)) continue;
    if (!path || task.never_touch.some((pattern) => matches(pattern, path))
      || !task.owns_paths.some((pattern) => matches(pattern, path))) unowned.push(rawPath);
  }
  return [...new Set(unowned)].sort();
}

/**
 * Sibling tasks of one run workspace: a changed path is owned when some task of the run owns it
 * and that same task does not never_touch it. A sibling's never_touch does not veto the owner's files.
 */
export function findUnownedRunChanges(changedPaths:string[], tasks:OwnershipTask[]):string[] {
  if (!tasks.length) return [...new Set(changedPaths)].sort();
  const unowned = changedPaths.filter((path) => tasks.every((task) => findUnownedChanges([path], task).length > 0));
  return [...new Set(unowned)].sort();
}
