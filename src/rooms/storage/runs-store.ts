import { OPEN_ATTEMPT_STATES } from "../state-machine";
import type { LanePilotDatabase } from "./database";

export function createRun(db: LanePilotDatabase, id: string, projectId: string, kind: "bb"|"cli" = "bb", writerWorkspacePath: string | null = null, runGate: "none"|"pre-merge" = "none", runPolicy:unknown = {schemaVersion:1,pools:{provider:5,verification:2}}, writerHostId: string | null = null): void {
  const now = Date.now();
  db.prepare("INSERT INTO lane_pilot_run(id,project_id,state,kind,created_at,updated_at,writer_workspace_path,run_gate,run_policy_json,writer_host_id) VALUES (?,?,\'pending\',?,?,?,?,?,?,?)")
    .run(id, projectId, kind, now, now, writerWorkspacePath, runGate, JSON.stringify(runPolicy), writerHostId);
}

/** The run's objective, kept from the first dispatch that names one: later ones never replace it. Trimmed and bounded. */
export function setRunObjective(db: LanePilotDatabase, runId: string, objective: string): boolean {
  const text = objective.trim().slice(0, 2000);
  if (!text) return false;
  return db.prepare("UPDATE lane_pilot_run SET objective=?, updated_at=? WHERE id=? AND objective IS NULL").run(text, Date.now(), runId).changes === 1;
}

/** The run's objective, or null while no dispatch has named one. */
export function getRunObjective(db: LanePilotDatabase, runId: string): string | null {
  const row = db.prepare("SELECT objective FROM lane_pilot_run WHERE id=?").get(runId) as {objective:string|null}|undefined;
  return row?.objective?.trim() || null;
}

export function getRunWriterHost(db: LanePilotDatabase, runId: string): string | null {
  const row = db.prepare("SELECT writer_host_id FROM lane_pilot_run WHERE id=?").get(runId) as {writer_host_id:string|null}|undefined;
  const hostId = row?.writer_host_id?.trim();
  return hostId ? hostId : null;
}

/** Bind a provisioned BB managed worktree once, before the run can dispatch any tasks. */
export function setRunWorkspace(db: LanePilotDatabase, runId: string, workspacePath: string, environmentId: string): boolean {
  const result = db.prepare(`UPDATE lane_pilot_run SET writer_workspace_path=?, writer_environment_id=?, updated_at=?
    WHERE id=? AND state='pending' AND writer_workspace_path IS NULL AND writer_environment_id IS NULL`)
    .run(workspacePath, environmentId, Date.now(), runId);
  return result.changes === 1;
}

export function freezeRunBinding(db: LanePilotDatabase, runId: string, binding: { hostId: string; workspacePath: string; environmentId: string }): boolean {
  const result = db.prepare(`UPDATE lane_pilot_run
    SET writer_host_id=?, writer_workspace_path=?, writer_environment_id=?, updated_at=?
    WHERE id=? AND state='pending'
      AND writer_host_id IS NULL
      AND writer_workspace_path IS NULL
      AND writer_environment_id IS NULL`)
    .run(binding.hostId, binding.workspacePath, binding.environmentId, Date.now(), runId);
  return result.changes === 1;
}

export function setRunState(db: LanePilotDatabase, runId: string, state: string): void {
  db.prepare("UPDATE lane_pilot_run SET state=?, updated_at=? WHERE id=?").run(state, Date.now(), runId);
}

export function closeRun(db: LanePilotDatabase, runId: string, closedBy: "rpc" | "cli" | "sweep" | "ttl"): boolean {
  return db.transaction(() => {
    const run = db.prepare("SELECT state,closed_at FROM lane_pilot_run WHERE id=?").get(runId) as
      {state:string;closed_at:number|null}|undefined;
    if (!run) throw new Error("run does not exist");
    if (run.closed_at) return true;
    const open = db.prepare(`SELECT 1 FROM lane_pilot_attempt WHERE run_id=? AND state IN (${OPEN_ATTEMPT_STATES.map(() => "?").join(",")}) LIMIT 1`)
      .get(runId, ...OPEN_ATTEMPT_STATES);
    if (open) return false;
    const now = Date.now();
    db.prepare("UPDATE lane_pilot_run SET state='closed',closed_at=?,closed_by=?,updated_at=? WHERE id=? AND closed_at IS NULL")
      .run(now, closedBy, now, runId);
    return true;
  }).immediate();
}

export function setRunThread(db: LanePilotDatabase, runId: string, threadId: string): void {
  db.prepare("UPDATE lane_pilot_run SET pm_thread_id=?, state=\'running\', updated_at=? WHERE id=?")
    .run(threadId, Date.now(), runId);
}

export function findOpenNativeRun(db: LanePilotDatabase, projectId: string, threadId: string): string | null {
  const row = db.prepare(`SELECT id FROM lane_pilot_run
    WHERE kind='cli' AND project_id=? AND pm_thread_id=? AND closed_at IS NULL
    ORDER BY created_at DESC LIMIT 1`).get(projectId, threadId) as { id: string } | undefined;
  return row?.id ?? null;
}

export function getRunSettingsScopes(db: LanePilotDatabase, runId: string): string[] {
  const row = db.prepare("SELECT settings_scopes_json FROM lane_pilot_run WHERE id=?").get(runId) as {settings_scopes_json:string|null}|undefined;
  try { const scopes = JSON.parse(row?.settings_scopes_json ?? "[]"); return Array.isArray(scopes) ? scopes.filter((item) => typeof item === "string") : []; }
  catch { return []; }
}

export function setRunSettingsScopes(db: LanePilotDatabase, runId: string, scopes: string[]): void {
  db.prepare("UPDATE lane_pilot_run SET settings_scopes_json=?, updated_at=? WHERE id=?").run(JSON.stringify(scopes), Date.now(), runId);
}

export function loadRunHelperPolicyJson(db: LanePilotDatabase, runId: string): string | null {
  const row = db.prepare("SELECT helper_policy_json FROM lane_pilot_run WHERE id=?").get(runId) as { helper_policy_json: string | null } | undefined;
  return row?.helper_policy_json ?? null;
}

export function persistRunHelperPolicyJson(db: LanePilotDatabase, runId: string, json: string): boolean {
  const result = db.prepare("UPDATE lane_pilot_run SET helper_policy_json=?, updated_at=? WHERE id=? AND helper_policy_json IS NULL")
    .run(json, Date.now(), runId);
  if (result.changes === 1) return true;
  const current = loadRunHelperPolicyJson(db, runId);
  return current === json;
}

export function getRun(db: LanePilotDatabase, runId: string): {
  id:string; project_id:string; pm_thread_id:string|null; state:string; kind:string; closed_at:number|null; writer_workspace_path:string|null; writer_environment_id:string|null; run_gate:"none"|"pre-merge";run_policy_json:string;
}|undefined {
  return db.prepare("SELECT id,project_id,pm_thread_id,state,kind,closed_at,writer_workspace_path,writer_environment_id,run_gate,run_policy_json FROM lane_pilot_run WHERE id=?").get(runId) as
    {id:string; project_id:string; pm_thread_id:string|null; state:string; kind:string; closed_at:number|null; writer_workspace_path:string|null; writer_environment_id:string|null; run_gate:"none"|"pre-merge";run_policy_json:string}|undefined;
}

export function claimActivation(
  db: LanePilotDatabase,
  args: { projectId:string; pmThreadId:string; runId:string },
): void {
  const existing = db.prepare("SELECT pm_thread_id,run_id FROM lane_pilot_activation WHERE project_id=?")
    .get(args.projectId) as {pm_thread_id:string; run_id:string}|undefined;
  if (existing && existing.pm_thread_id !== args.pmThreadId) {
    const sameRun = existing.run_id === args.runId;
    const stalePending = existing.pm_thread_id.startsWith("pending:");
    if (!sameRun && !stalePending) {
      const run = getRun(db, existing.run_id);
      if (run && (run.state === "pending" || run.state === "running")) {
        throw new Error(
          `Lane Pilot is already active in this project (thread ${existing.pm_thread_id}). A second activation is blocked.`,
        );
      }
    }
  }
  db.prepare(`INSERT INTO lane_pilot_activation(project_id,pm_thread_id,run_id,claimed_at) VALUES (?,?,?,?)
    ON CONFLICT(project_id) DO UPDATE SET pm_thread_id=excluded.pm_thread_id, run_id=excluded.run_id, claimed_at=excluded.claimed_at`)
    .run(args.projectId, args.pmThreadId, args.runId, Date.now());
}

export function getActivation(db: LanePilotDatabase, projectId: string): {
  pm_thread_id:string; run_id:string;
}|undefined {
  return db.prepare("SELECT pm_thread_id,run_id FROM lane_pilot_activation WHERE project_id=?").get(projectId) as
    {pm_thread_id:string; run_id:string}|undefined;
}

export function releaseActivation(db: LanePilotDatabase, projectId: string, runId?: string): void {
  if (runId) db.prepare("DELETE FROM lane_pilot_activation WHERE project_id=? AND run_id=?").run(projectId, runId);
  else db.prepare("DELETE FROM lane_pilot_activation WHERE project_id=?").run(projectId);
}

export function listRunsWithAttempts(db: LanePilotDatabase, projectId: string): Array<{
  id:string; state:string; kind:string; created_at:number; updated_at:number; closed_at:number|null; pm_thread_id:string|null;
  attempts: Array<{
    id:string; state:string; attempt_no:number; thread_id:string|null; reason:string|null; task_id:string;
  }>;
}> {
  const runs = db.prepare(`SELECT id,state,kind,created_at,updated_at,closed_at,pm_thread_id FROM lane_pilot_run
    WHERE project_id=? ORDER BY created_at DESC`).all(projectId) as Array<{
    id:string; state:string; kind:string; created_at:number; updated_at:number; closed_at:number|null; pm_thread_id:string|null;
  }>;
  return runs.map((run) => ({
    ...run,
    attempts: db.prepare(`SELECT id,state,attempt_no,thread_id,reason,task_id FROM lane_pilot_attempt
      WHERE run_id=? ORDER BY attempt_no`).all(run.id) as Array<{
      id:string; state:string; attempt_no:number; thread_id:string|null; reason:string|null; task_id:string;
    }>,
  }));
}

export type RunHistoryRow = {
  id:string; state:string; kind:string; created_at:number; updated_at:number; closed_at:number|null; pm_thread_id:string|null;
  attempts: Array<{ id:string; state:string; attempt_no:number; thread_id:string|null; reason:string|null; task_id:string }>;
};

/** How much of an attempt's reason the run list carries; the full reason stays in the database. */
export const SCREEN_REASON_CHARS = 4000;

/** A page of a project's runs, newest first, with their attempts; `pinOpen` adds the runs that are still open beyond the page. */
export function listRunsPage(db: LanePilotDatabase, projectId: string, page: { limit:number; offset:number; pinOpen?:boolean }): { runs:RunHistoryRow[]; total:number } {
  const rows = db.prepare(`SELECT id,state,kind,created_at,updated_at,closed_at,pm_thread_id FROM lane_pilot_run
    WHERE project_id=? ORDER BY created_at DESC`).all(projectId) as Array<Omit<RunHistoryRow,"attempts">>;
  const picked = rows.filter((run, index) => (index >= page.offset && index < page.offset + page.limit) || (page.pinOpen && !run.closed_at));
  // The screen shows a reason, it does not process it: three reasons listing 49 434 stray paths (4.7 MB each, BB-сервис
  // 2026-10-10) made every load of the project 14 MB and left the role pickers on «loading» for seconds.
  const attempts = db.prepare(`SELECT id,state,attempt_no,thread_id,CASE WHEN length(reason)>${SCREEN_REASON_CHARS}
    THEN substr(reason,1,${SCREEN_REASON_CHARS})||' … ('||(length(reason)-${SCREEN_REASON_CHARS})||' more characters)' ELSE reason END AS reason,task_id
    FROM lane_pilot_attempt WHERE run_id=? ORDER BY attempt_no`);
  return {
    total: rows.length,
    runs: picked.map((run) => ({ ...run, attempts: attempts.all(run.id) as RunHistoryRow["attempts"] })),
  };
}
