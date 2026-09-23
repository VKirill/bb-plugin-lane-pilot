import { posix } from "node:path";

export type OwnershipTask = {
  project_cwd:string;
  owns_paths:string[];
  never_touch:string[];
  verification:Array<{ cwd:string }>;
};

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

export function findUnownedChanges(changedPaths:string[], task:OwnershipTask):string[] {
  const unowned:string[] = [];
  for (const rawPath of changedPaths) {
    const path = safeRelative(rawPath);
    if (!path || task.never_touch.some((pattern) => matches(pattern, path))
      || !task.owns_paths.some((pattern) => matches(pattern, path))) unowned.push(rawPath);
  }
  return [...new Set(unowned)].sort();
}
