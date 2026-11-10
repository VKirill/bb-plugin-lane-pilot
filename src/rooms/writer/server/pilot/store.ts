import { ownsPathsOverlap } from "@lane-pilot/kit";
import { FREE_CLASSES, failureClass } from "../../../contracts";

/** The wall rows a pilot's hold check reads (typed structurally: pilot is under wall in the room graph). */
export type TaskWallRow = { state: string; pack: unknown };
import type { RunTask } from "./logic";

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
  return cls === "provider" || FREE_CLASSES.has(cls);
}

/**
 * Whether the wall ladder (src/rooms/wall) holds a blocked pilot, so no redo is coming soon: a task wall on its family in this run (its two
 * normal moves are spent; the family is not sent again while the hunters read it), or a loop hunt that is still running on a file the
 * pilot owns. The siblings of such a pilot are let go at once instead of waiting for a resend that the machine itself told the PM not to make.
 */
export function pilotUnderWall(walls: readonly TaskWallRow[], runId: string, family: string, ownsPaths: readonly string[]): boolean {
  return walls.some((row) => {
    const meta = (row.pack as { meta?: { runId?: unknown; family?: unknown; topic?: unknown } } | null)?.meta;
    if (!meta || meta.runId !== runId) return false;
    if (meta.family === family) return true;
    return typeof meta.topic === "string" && meta.topic.length > 0 && (row.state === "stopped" || row.state === "hunting") && ownsPathsOverlap([meta.topic], [...ownsPaths]);
  });
}
