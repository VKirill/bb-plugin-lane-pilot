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
export function pilotOf(taskId: string, tasks: readonly RunTask[], min = PILOT_MIN_SIBLINGS): string | null {
  const own = tasks.find((task) => task.id === taskId);
  if (!own?.area || own.dependsOn.length) return null;
  const siblings = tasks.filter((task) => task.area === own.area && task.kind === own.kind);
  if (siblings.length < min) return null;
  const pilot = siblings.filter((task) => !task.dependsOn.length).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
  return pilot && pilot.id !== taskId ? pilot.id : null;
}
