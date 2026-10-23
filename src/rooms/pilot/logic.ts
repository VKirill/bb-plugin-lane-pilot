/**
 * Pilot, then fan-out (SMA atlas D2-2: «Wave pilot piece», «Wave fan-out open»). Sibling tasks of one run — the same area and the same kind —
 * tend to fail the same way. When a run has at least three of them, the first one dispatched is the pilot: the others start only once it
 * is accepted, through the same wait as `depends_on` (a blocked pilot is waited for while the PM sends it again, up to six hours; a canceled
 * pilot holds no one). The area rule already runs them one after another; the pilot rule keeps the rest from starting after a failure.
 */
export const PILOT_MIN_SIBLINGS = 3;
export type RunTask = { id: string; area: string | null; kind: string | null; createdAt: number; dependsOn: readonly string[] };

/**
 * The pilot this task waits for, or null: too few siblings, no area, the task is the pilot, or the PM already ordered the task with
 * depends_on (then its own order holds and no pilot is added, so the two can never wait for each other). The pilot is the earliest sibling
 * that depends on nothing.
 */
/** `vf-t0-test-infra.3` and `vf-t0-test-infra` are one task sent again: the family is the id without its redo suffix. */
export const taskFamilyOf = (id: string): string => id.replace(/\.\d+$/, "");

export function pilotOf(taskId: string, tasks: readonly RunTask[], min = PILOT_MIN_SIBLINGS): string | null {
  const own = tasks.find((task) => task.id === taskId);
  if (!own?.area || own.dependsOn.length) return null;
  // One task sent again is one sibling, not three: the redos of a blocked task made it its own pilot's sibling, and the third
  // version waited for the first, blocked one (Vampirism Fire vf-t0-test-infra.3, 2026-10-23).
  const families = new Map<string, RunTask>();
  for (const task of tasks) {
    if (task.area !== own.area || task.kind !== own.kind) continue;
    const family = taskFamilyOf(task.id), first = families.get(family);
    if (!first || task.createdAt < first.createdAt) families.set(family, task);
  }
  if (families.size < min) return null;
  const pilot = [...families.values()].filter((task) => !task.dependsOn.length).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
  return pilot && taskFamilyOf(pilot.id) !== taskFamilyOf(taskId) ? pilot.id : null;
}
