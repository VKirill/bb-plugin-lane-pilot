// The integration gate's run ledger (lane_pilot_gate_run): one row per post-merge check on main.
import type { LanePilotDatabase } from "./database";

export type GateRunState = "running" | "passed" | "failed" | "not_run";
export type GateRunRow = {
  id: number;
  projectId: string;
  runId: string;
  scopeKey: string;
  command: string;
  state: GateRunState;
  head: string | null;
  reason: string | null;
  batch: Array<{ taskId: string; commitSha: string }>;
  updatedAt: number;
};

export function gateRunRow(raw: Record<string, unknown>): GateRunRow {
  let batch: GateRunRow["batch"] = [];
  try { batch = JSON.parse(raw.batch_json as string) as GateRunRow["batch"]; } catch { /* empty */ }
  return {
    id: raw.id as number, projectId: raw.project_id as string, runId: raw.run_id as string,
    scopeKey: raw.scope_key as string, command: raw.command as string, state: raw.state as GateRunState,
    head: (raw.head as string | null) ?? null, reason: (raw.reason as string | null) ?? null, batch,
    updatedAt: raw.updated_at as number,
  };
}

export type GateRunBatchTask = { taskId: string; commitSha: string; threadId?: string | null; attemptId?: string | null; produced?: string[] };

/** The run's record goes down before it starts: «accepted» alone never says the gate is still out. */
export function noteGateRunStart(db: LanePilotDatabase, input: {
  projectId: string; runId: string; scopeKey: string; command: string; batch: ReadonlyArray<GateRunBatchTask>;
}): number {
  return Number(db.prepare(`INSERT INTO lane_pilot_gate_run (project_id,run_id,scope_key,command,state,batch_json,updated_at)
    VALUES (?,?,?,?,'running',?,?)`)
    .run(input.projectId, input.runId, input.scopeKey, input.command,
      JSON.stringify(input.batch.map((task) => ({ taskId: task.taskId, commitSha: task.commitSha }))), Date.now()).lastInsertRowid);
}

export function finishGateRun(db: LanePilotDatabase, id: number, state: Exclude<GateRunState, "running">, fields: { head?: string | null; reason?: string | null }): void {
  db.prepare("UPDATE lane_pilot_gate_run SET state=?, head=?, reason=?, updated_at=? WHERE id=?")
    .run(state, fields.head ?? null, fields.reason ?? null, Date.now(), id);
}

/** The latest gate run that checked a merge of this task (its task id rides the batch), per project. */
export function latestGateRunForTask(db: LanePilotDatabase, projectId: string, taskId: string): GateRunRow | undefined {
  const raw = db.prepare(`SELECT * FROM lane_pilot_gate_run WHERE project_id=? AND EXISTS (
      SELECT 1 FROM json_each(lane_pilot_gate_run.batch_json) WHERE json_extract(value,'$.taskId')=?)
    ORDER BY id DESC LIMIT 1`).get(projectId, taskId) as Record<string, unknown> | undefined;
  return raw ? gateRunRow(raw) : undefined;
}

/** The newest gate run of the project — what preship measures the head being shipped against. */
export function latestGateRun(db: LanePilotDatabase, projectId?: string): GateRunRow | undefined {
  const raw = (projectId
    ? db.prepare("SELECT * FROM lane_pilot_gate_run WHERE project_id=? ORDER BY id DESC LIMIT 1").get(projectId)
    : db.prepare("SELECT * FROM lane_pilot_gate_run ORDER BY id DESC LIMIT 1").get()) as Record<string, unknown> | undefined;
  return raw ? gateRunRow(raw) : undefined;
}

/** How long a green run of the full integration gate counts as proof for a ship (SMA k_ws_fullgate). */
export const FULL_GATE_VALID_MS = 6 * 3_600 * 1000;

/**
 * The full-gate mark of a ship (SMA k_ws_fullgate): the newest gate run passed, on this very head, no more than six hours ago.
 * `head` null means the caller cannot name the shipped head (preship reads no checkout): the head check is then not applied.
 */
export function fullGateVerdict(row: GateRunRow | undefined, head: string | null, now = Date.now()): { ok: boolean; reason: string } {
  if (!row) return { ok: false, reason: "no integration gate run is recorded" };
  if (row.state === "running") return { ok: false, reason: `the integration gate is still running (${row.command})` };
  if (row.state !== "passed") return { ok: false, reason: `the integration gate is red: ${row.command}${row.reason ? ` (${row.reason.slice(0, 160)})` : ""}` };
  if (now - row.updatedAt > FULL_GATE_VALID_MS) return { ok: false, reason: `the gate's green mark is older than six hours (on ${row.head?.slice(0, 12) ?? "unknown commit"})` };
  if (head && row.head !== head) return { ok: false, reason: `the gate's green mark is on ${row.head?.slice(0, 12) ?? "unknown commit"}, not on the head being shipped ${head.slice(0, 12)}` };
  return { ok: true, reason: `green on ${row.head?.slice(0, 12) ?? head?.slice(0, 12) ?? "?"} within six hours` };
}
