import { fileBlockedByNeverTouch, matchOwnsPath } from "@lane-pilot/kit";
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

export function safeRelative(value:string):string|null {
  if (!value || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return null;
  const normalized = posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  if (normalized.split("/").includes("..")) return null;
  return normalized;
}

function matches(pattern:string, path:string):boolean {
  const normalized = safeRelative(pattern);
  if (!normalized) return false;
  // One matcher for the whole plugin (owns-paths.ts): plain paths cover what is under them, a double star crosses
  // folders and wildcards inside names work. They did not here, and correct SelfyStudio work was rejected.
  return matchOwnsPath(path, pattern.endsWith("/") && !normalized.endsWith("/") ? `${normalized}/` : normalized);
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

/**
 * Satellite files (F-02): a change that legitimately sits next to an owned change but outside owns_paths —
 * the test of the changed file, the locale of the changed area. 42 % of a month of owns-paths rejections were
 * 54 such repeating paths. A satellite needs an anchor: a changed file of the same attempt that IS owned; with
 * no owned change an unmatched test or locale is still a violation.
 * Build debris is not here: it is ownership noise (BUILD_OUTPUT_DIRS), legitimate without any anchor.
 */
const SATELLITE_TEST_DIRS = new Set(["test","tests","__tests__","spec","specs","e2e"]);
const SATELLITE_LOCALE_DIRS = new Set(["locale","locales","i18n","l10n","lang","langs","translations","messages","strings","resources"]);
const SATELLITE_TEST_NAME = /(?:^|[._-])(?:test|tests|spec|specs)\.[^.]+$/i;
const SATELLITE_LOCALE_NAME = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*\.(?:json|ya?ml|po|mo|pot|ftl|resx|arb|ts|js)$/i;

function satelliteKind(path:string):"test"|"locale"|null {
  const parts = path.split("/");
  const name = parts[parts.length-1] ?? "";
  if (parts.slice(0,-1).some((part) => SATELLITE_TEST_DIRS.has(part)) || SATELLITE_TEST_NAME.test(name)) return "test";
  if (parts.slice(0,-1).some((part) => SATELLITE_LOCALE_DIRS.has(part)) || SATELLITE_LOCALE_NAME.test(name)) return "locale";
  return null;
}

/** The area a path belongs to: the package for a monorepo (`packages/<name>`), the top folder elsewhere. */
function areaRoot(path:string):string {
  const parts = path.split("/");
  return parts[0] === "packages" && parts[1] ? `${parts[0]}/${parts[1]}` : (parts[0] ?? "");
}

/** The name a test points at: `start.test.ts` and `test_start.py` both name `start`. */
function satelliteStem(path:string):string {
  const name = (path.split("/").pop() ?? "").replace(/\.[^.]+$/, "");
  return name.replace(/\.(?:tests?|specs?)$|_test$|_spec$|^test[_-]|^spec[_-]/i, "");
}

/**
 * True when `path` is a test or a locale file that belongs to the attempt's own work: a locale of the same area
 * (`game/assets/lang/en.json` beside `game/src/…`), a test of the same area, or a test naming an anchor
 * (`tests/start.test.ts` beside `src/rooms/…/start.ts`).
 */
export function satelliteOf(path:string, anchors:readonly string[]):boolean {
  const kind = satelliteKind(path);
  if (!kind) return false;
  const area = areaRoot(path);
  const stem = satelliteStem(path);
  const parts = path.split("/");
  // A test under its own <tests|__tests__> folder belongs to the code the folder's parent covers
  // (apps/api/__tests__/x.test.ts ↔ apps/api/checkout/routes.ts); a bare tests/foo.test.ts needs the stem.
  const testParent = kind === "test" && parts.length > 2 && SATELLITE_TEST_DIRS.has(parts[parts.length-2]!)
    ? parts.slice(0, -2).join("/") : null;
  if (kind === "locale") return anchors.some((anchor) => areaRoot(anchor) === area);
  return anchors.some((anchor) => (stem !== "" && satelliteStem(anchor) === stem)
    || (testParent !== null && testParent !== "" && anchor.startsWith(`${testParent}/`)));
}

/**
 * Split the paths a check rejected into real violations and satellites of the attempt's own owned changes.
 * `anchors` are the attempt's changed paths that passed the ownership check (this task's or a run sibling's).
 */
export function dropSatellites(unowned:string[], anchors:readonly string[], neverTouch:readonly string[]=[]):{unowned:string[];satellites:string[]} {
  const satellites:string[] = [];
  const kept:string[] = [];
  // never_touch wins over a satellite: a test-shaped path the contract forbids stays forbidden.
  for (const path of unowned) (fileBlockedByNeverTouch(path, [...neverTouch]) || !satelliteOf(path, anchors) ? kept : satellites).push(path);
  return { unowned: kept.sort(), satellites: satellites.sort() };
}
