/**
 * Pilot, then fan-out (SMA atlas D2-2: «Wave pilot piece», «Wave fan-out open»). Sibling tasks of one run — the same area and the same kind —
 * tend to fail the same way. When a run has at least three of them, the first one dispatched is the pilot: the others start only once it
 * is accepted, through the same wait as `depends_on` (a blocked pilot is waited for while the PM sends it again, up to six hours; a canceled
 * pilot holds no one). The area rule already runs them one after another; the pilot rule keeps the rest from starting after a failure.
 */
export const PILOT_MIN_SIBLINGS = 3;
export type RunTask = { id: string; area: string | null; kind: string | null; createdAt: number };

/** The pilot this task waits for, or null (too few siblings, no area, or the task is the pilot itself). */
export function pilotOf(taskId: string, tasks: readonly RunTask[], min = PILOT_MIN_SIBLINGS): string | null {
  const own = tasks.find((task) => task.id === taskId);
  if (!own?.area) return null;
  const siblings = tasks.filter((task) => task.area === own.area && task.kind === own.kind).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  if (siblings.length < min || siblings[0]!.id === taskId) return null;
  return siblings[0]!.id;
}
