import type Database from "better-sqlite3";
import { ownsPathsOverlap } from "@lane-pilot/kit";
import type { RunTask } from "./logic";

/**
 * The tasks of a run with their area, kind, owned paths and whether the latest attempt was canceled, as `pilotOf` reads them.
 * Only the PM's own tasks carry owns_paths here: a mainfix or a workflow's task is not part of a wave and waits for no pilot.
 */
export function runTasks(db: Pick<Database.Database, "prepare">, runId: string): RunTask[] {
  const canceled = new Set((db.prepare(`SELECT task_id FROM lane_pilot_attempt a WHERE run_id=? AND state='canceled'
    AND NOT EXISTS (SELECT 1 FROM lane_pilot_attempt b WHERE b.run_id=a.run_id AND b.task_id=a.task_id AND (b.created_at>a.created_at OR (b.created_at=a.created_at AND b.attempt_no>a.attempt_no)))`)
    .all(runId) as Array<{ task_id: string }>).map((row) => row.task_id));
  return (db.prepare("SELECT id, contract_json, created_at, birth FROM lane_pilot_task WHERE run_id=?").all(runId) as Array<{ id: string; contract_json: string; created_at: number; birth: string | null }>).map((row) => {
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
 * Whether the wall ladder (src/rooms/wall) holds a blocked pilot, so no redo is coming soon: a task wall on its family in this run (its two
 * normal moves are spent; the family is not sent again while the hunters read it), or a loop hunt that is still running on a file the
 * pilot owns. The siblings of such a pilot are let go at once instead of waiting for a resend that the machine itself told the PM not to make.
 */
export function pilotUnderWall(db: Pick<Database.Database, "prepare">, runId: string, family: string, ownsPaths: readonly string[]): boolean {
  let rows: Array<{ state: string; pack_json: string | null }>;
  try { rows = db.prepare("SELECT state, pack_json FROM lane_pilot_wall WHERE kind='task' AND state IN ('stopped','hunting','hunted','backlog')").all() as typeof rows; } catch { return false; }
  return rows.some((row) => {
    let meta: { runId?: unknown; family?: unknown; topic?: unknown } | undefined;
    try { meta = (JSON.parse(row.pack_json ?? "null") as { meta?: typeof meta } | null)?.meta; } catch { return false; }
    if (!meta || meta.runId !== runId) return false;
    if (meta.family === family) return true;
    return typeof meta.topic === "string" && meta.topic.length > 0 && (row.state === "stopped" || row.state === "hunting") && ownsPathsOverlap([meta.topic], [...ownsPaths]);
  });
}
