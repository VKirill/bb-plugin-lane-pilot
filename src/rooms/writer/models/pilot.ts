import { FREE_CLASSES, failureClass } from "../../contracts";
import { taskRedispatchBase } from "@lane-pilot/contracts";
import { ownsPathsOverlap } from "@lane-pilot/kit";

/**
 * Pilot, then fan-out (SMA atlas D2-2: «Wave pilot piece», «Wave fan-out open»). Sibling tasks of one run — the same area and the same kind —
 * tend to fail the same way. When a run has at least three of them, the first one dispatched is the pilot: the others start only once it
 * is accepted, through the same wait as `depends_on` (a blocked pilot is waited for while the PM sends it again, up to six hours; a canceled
 * pilot holds no one). The area rule already runs them one after another; the pilot rule keeps the rest from starting after a failure.
 *
 * A shared resource makes a pilot too: tasks of one run dispatched within `PILOT_WINDOW_MS` of each other whose owns_paths overlap
 * (the scheduler's `ownsPathsOverlap`) form a wave, and from `PILOT_MIN_SHARING` of them the first one is the pilot. Vampirism Fire
 * waves all owned `scripts/gamedata/` and shared one Studio, 10-22 overlapping pairs a wave, and the same failure repeated across the wave
 * while the area-and-kind rule never fired. The task contract declares no external resource, so owns_paths overlap is the only signal.
 */
export const PILOT_MIN_SIBLINGS = 3;
/** Tasks of one wave sharing owns_paths (the pilot included) from which the first is the pilot. */
export const PILOT_MIN_SHARING = 3;
/** Two overlapping tasks dispatched further apart than this are not one wave. */
export const PILOT_WINDOW_MS = 30 * 60_000;
export type RunTask = { id: string; area: string | null; kind: string | null; createdAt: number; dependsOn: readonly string[]; ownsPaths?: readonly string[]; canceled?: boolean };

/**
 * The pilot this task waits for, or null: too few siblings, no area, the task is the pilot, or the PM already ordered the task with
 * depends_on (then its own order holds and no pilot is added, so the two can never wait for each other). The pilot is the earliest sibling
 * that depends on nothing.
 */
export function pilotOf(taskId: string, tasks: readonly RunTask[], min = PILOT_MIN_SIBLINGS): string | null {
  const own = tasks.find((task) => task.id === taskId);
  if (!own || own.dependsOn.length) return null;
  return areaPilotOf(own, tasks, min) ?? sharedResourcePilotOf(own, tasks);
}

/**
 * The wave this task belongs to, by shared owns_paths: its first task is the pilot. Linked tasks are chained through overlap within the
 * window, so a wave whose first and last tasks share nothing directly is still one wave. Tasks the PM ordered with depends_on, and
 * canceled ones, are outside it; a task sent again counts once. Every wait points at an earlier task, so no two tasks wait for each other.
 */
function sharedResourcePilotOf(own: RunTask, tasks: readonly RunTask[], min = PILOT_MIN_SHARING): string | null {
  const families = new Map<string, RunTask>();
  for (const task of tasks) {
    if (task.canceled || task.dependsOn.length || !task.ownsPaths?.length) continue;
    const family = taskRedispatchBase(task.id), first = families.get(family);
    if (!first || task.createdAt < first.createdAt || (task.createdAt === first.createdAt && task.id < first.id)) families.set(family, task);
  }
  const wave = [...families.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const mine = wave.findIndex((task) => taskRedispatchBase(task.id) === taskRedispatchBase(own.id));
  if (mine < 0) return null;
  const group = new Set([mine]);
  for (const queue = [mine]; queue.length;) {
    const at = queue.pop()!;
    wave.forEach((other, index) => {
      if (group.has(index) || Math.abs(other.createdAt - wave[at]!.createdAt) > PILOT_WINDOW_MS || !ownsPathsOverlap([...wave[at]!.ownsPaths!], [...other.ownsPaths!])) return;
      group.add(index);
      queue.push(index);
    });
  }
  if (group.size < min) return null;
  const pilot = wave[Math.min(...group)]!;
  return taskRedispatchBase(pilot.id) === taskRedispatchBase(own.id) ? null : pilot.id;
}

function areaPilotOf(own: RunTask, tasks: readonly RunTask[], min: number): string | null {
  if (!own.area) return null;
  // One task sent again is one sibling, not three: the redos of a blocked task made it its own pilot's sibling, and the third
  // version waited for the first, blocked one (Vampirism Fire vf-t0-test-infra.3, 2026-10-23).
  const families = new Map<string, RunTask>();
  for (const task of tasks) {
    if (task.area !== own.area || task.kind !== own.kind) continue;
    const family = taskRedispatchBase(task.id), first = families.get(family);
    if (!first || task.createdAt < first.createdAt) families.set(family, task);
  }
  if (families.size < min) return null;
  const pilot = [...families.values()].filter((task) => !task.dependsOn.length).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
  return pilot && taskRedispatchBase(pilot.id) !== taskRedispatchBase(own.id) ? pilot.id : null;
}


/**
 * The tasks of a run with their area, kind, owned paths and whether the latest attempt was canceled, as `pilotOf` reads them.
 * Only the PM's own tasks carry owns_paths here: a mainfix or a workflow's task is not part of a wave and waits for no pilot.
 */
export type PilotTaskRow = { id: string; contract_json: string; created_at: number; birth: string | null };
export function runTasks(rows: PilotTaskRow[], canceledIds: readonly string[]): RunTask[] {
  const canceled = new Set(canceledIds);
  return rows.map((row) => {
    let contract: { area?: unknown; kind?: unknown; depends_on?: unknown; owns_paths?: unknown } = {};
    try { contract = JSON.parse(row.contract_json) as typeof contract; } catch { /* a stored contract that does not parse has no area */ }
    const own = row.birth === "pm" && !/-mainfix(\.\d+)*$/.test(row.id) && Array.isArray(contract.owns_paths)
      ? contract.owns_paths.filter((path): path is string => typeof path === "string" && path.length > 0) : [];
    return { id: row.id, area: typeof contract.area === "string" && contract.area ? contract.area : null, kind: typeof contract.kind === "string" ? contract.kind : null, createdAt: row.created_at,
      dependsOn: Array.isArray(contract.depends_on) ? contract.depends_on.filter((dep): dep is string => typeof dep === "string" && dep.length > 0) : [],
      ...(own.length ? { ownsPaths: own } : {}), ...(canceled.has(row.id) ? { canceled: true } : {}) };
  });
}

/**
 * A pilot's block that says nothing about its siblings: the provider's, the machine's or Lane Pilot's own, not the task's content.
 * The pilot exists because siblings fail the same way; a pilot nobody could run shows no way. feed-gen 2026-11-10: the pilot of area
 * «generator» ended blocked on a silent Devin and an Antigravity session the core could not start, and the next task of the area stood
 * 75 minutes behind it until the PM canceled it and sent it again under another area name.
 */
export function pilotBlockedByOthers(state: string, reason: string | null): boolean {
  const cls = failureClass(state, reason);
  return FREE_CLASSES.has(cls);
}
