import { fileAllowedByOwns, fileBlockedByNeverTouch } from "@lane-pilot/kit";
import type { TaskV2 } from "../../contracts";
import type { DirtSnapshot } from "./cli-outcome";

export type CheckRevision = { head:string|null; dirty:number|null };
// git runs only under a `.git` found up the tree, as git finds it: a live folder (no git) is never touched by git (live-folder-flow.test.ts).
export const REVISION_PROBE = 'd=$PWD; while [ "$d" != / ] && [ ! -e "$d/.git" ]; do d=$(dirname "$d"); done; if [ -e "$d/.git" ]; then git rev-parse HEAD 2>/dev/null || echo -; git status --porcelain 2>/dev/null | wc -l; else echo -; fi';
/** The probe's two lines: the HEAD sha (or `-`) and the count of `git status --porcelain` lines. */
export function parseRevisionProbe(stdout:string):CheckRevision {
  const [head, dirty] = stdout.trim().split(/\s+/);
  return { head:head && /^[0-9a-f]{40}$/.test(head) ? head : null, dirty:dirty && /^\d+$/.test(dirty) ? Number(dirty) : null };
}

/**
 * A check that exited 0 but whose runner counted no executed test (a mistyped `-t`, a `passWithNoTests` in the config, a
 * filter that matches no file) proves nothing: it fails, and the writer reads why in the check's stderr (the retry brief
 * quotes it). Output that is not a test runner's summary (tsc, lint, a script) is left as it is.
 */

export function familyDirtBaseline(task:Pick<TaskV2,"owns_paths"|"never_touch">, dirtBefore:DirtSnapshot[], familyProduced:ReadonlySet<string> = new Set<string>()):DirtSnapshot[] {
  return dirtBefore.filter((row) => {
    const owned = fileAllowedByOwns(row.path, task.owns_paths) && !fileBlockedByNeverTouch(row.path, task.never_touch);
    return !(owned && familyProduced.has(row.path));
  });
}

