import type Database from "better-sqlite3";
import type { RunTask } from "./logic";

/** The tasks of a run with their area and kind, as `pilotOf` reads them. */
export function runTasks(db: Pick<Database.Database, "prepare">, runId: string): RunTask[] {
  return (db.prepare("SELECT id, contract_json, created_at FROM lane_pilot_task WHERE run_id=?").all(runId) as Array<{ id: string; contract_json: string; created_at: number }>).map((row) => {
    let contract: { area?: unknown; kind?: unknown; depends_on?: unknown } = {};
    try { contract = JSON.parse(row.contract_json) as typeof contract; } catch { /* a stored contract that does not parse has no area */ }
    return { id: row.id, area: typeof contract.area === "string" && contract.area ? contract.area : null, kind: typeof contract.kind === "string" ? contract.kind : null, createdAt: row.created_at,
      dependsOn: Array.isArray(contract.depends_on) ? contract.depends_on.filter((dep): dep is string => typeof dep === "string" && dep.length > 0) : [] };
  });
}
