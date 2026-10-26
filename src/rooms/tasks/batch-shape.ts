import { ownsPathsOverlap } from "@lane-pilot/kit";

/**
 * Advice at dispatch on the shape of a batch (not a refusal). Tasks whose owns_paths overlap run one at a time, so a batch whose
 * tasks all own the same folder is a queue: Vampirism Fire (2026-10) had 223 h of queue wait against 140 h of work because nearly
 * every mechanic task owned the whole generator folder `scripts/gamedata/` (waves of 7-10 tasks, 10-22 overlapping pairs;
 * vf-s6-world waited 14.8 h for 0.5 h of work), and tiny follow-ups each paid a full writer start, critique, checks and merge.
 */

export interface OpenShape { id: string; ownsPaths: string[]; dependsOn: string[] }

/** This many tasks owning one path (the new task counts) make the batch a queue worth saying so. */
export const SHARED_PATH_TASKS = 3;
const LISTED = 5;

/** The part of a pattern before its first wildcard, as the ownership overlap rule reads it. */
const literalBase = (pattern: string): string => {
  const parts: string[] = [];
  for (const part of pattern.replaceAll("\\", "/").replace(/^\.\//, "").split("/")) {
    if (/[*?[]/.test(part)) break;
    parts.push(part);
  }
  return parts.join("/").replace(/\/+$/, "");
};

/** The paths two ownership lists share: for each overlapping pair the narrower one (a file inside an owned folder is the shared ground). */
function sharedPaths(mine: readonly string[], theirs: readonly string[]): string[] {
  const shared = new Set<string>();
  for (const left of mine) for (const right of theirs) {
    if (ownsPathsOverlap([left], [right])) shared.add(literalBase(left).length >= literalBase(right).length ? left : right);
  }
  return [...shared];
}

const list = (items: readonly string[]) => `${items.slice(0, LISTED).join(", ")}${items.length > LISTED ? `, +${items.length - LISTED}` : ""}`;

/** Short lines for the PM: which open tasks hold the new one and on what, and the fix when three or more own one path. */
export function batchShapeAdvice(task: { id: string; ownsPaths: string[]; dependsOn: string[] }, open: readonly OpenShape[]): string[] {
  // A task that depends on the other (either way) is ordered on purpose; it is no surprise queue.
  const holders = open.filter((other) => other.id !== task.id && !task.dependsOn.includes(other.id) && !other.dependsOn.includes(task.id) && ownsPathsOverlap(task.ownsPaths, other.ownsPaths));
  if (!holders.length) return [];
  const held = holders.map((other) => ({ id: other.id, paths: sharedPaths(task.ownsPaths, other.ownsPaths) }));
  const advice = [`queue: ${task.id} waits for ${held.length} open task${held.length === 1 ? "" : "s"} ahead because their owns_paths overlap (${list(held.map((row) => `${row.id}: ${list(row.paths)}`))}); it starts after them, not beside them.`];
  const crowd = new Map<string, string[]>();
  for (const row of held) for (const path of row.paths) crowd.set(path, [...(crowd.get(path) ?? []), row.id]);
  const [path, ids] = [...crowd].sort((a, b) => b[1].length - a[1].length)[0]!;
  if (ids.length + 1 >= SHARED_PATH_TASKS) {
    advice.push(`shape: ${ids.length + 1} open tasks (${list([...ids, task.id])}) own ${path}, so they run one by one. Narrow owns_paths to the files each really changes, or move the shared change in ${path} into one task the others depend on, or merge tiny tasks of one area into one (a task is 30-120 minutes of work).`);
  }
  return advice;
}
