import { OPEN_ATTEMPT_STATES } from "../contracts/state-machine";
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
  id:string; project_id:string; pm_thread_id:string|null; state:string; kind:string; closed_at:number|null; writer_workspace_path:string|null; writer_environment_id:string|null; run_gate:"none"|"pre-merge";run_policy_json:string; created_at:number;
}|undefined {
  return db.prepare("SELECT id,project_id,pm_thread_id,state,kind,closed_at,writer_workspace_path,writer_environment_id,run_gate,run_policy_json,created_at FROM lane_pilot_run WHERE id=?").get(runId) as
    {id:string; project_id:string; pm_thread_id:string|null; state:string; kind:string; closed_at:number|null; writer_workspace_path:string|null; writer_environment_id:string|null; run_gate:"none"|"pre-merge";run_policy_json:string; created_at:number}|undefined;
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
export const RUN_TABLE = "lane_pilot_run";

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

/** The run a PM thread drives, latest first (a PM thread has at most one open run). */
export function latestRunForPmThread(db: LanePilotDatabase, threadId: string): { id: string } | undefined {
  return db.prepare("SELECT id FROM lane_pilot_run WHERE pm_thread_id=? ORDER BY created_at DESC LIMIT 1").get(threadId) as { id: string } | undefined;
}

/** Whether any Lane Pilot run belongs to this PM thread (how a PM chat is recognized without a kept list). */
export function hasRunForPmThread(db: LanePilotDatabase, threadId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM lane_pilot_run WHERE pm_thread_id=? LIMIT 1").get(threadId));
}

/** The run an attempt belongs to: the project and PM thread a signal about the attempt is for. */
export function attemptRunRef(db: LanePilotDatabase, attemptId: string): { project_id: string; pm_thread_id: string | null } | undefined {
  return db.prepare("SELECT r.project_id, r.pm_thread_id FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id WHERE a.id=?")
    .get(attemptId) as { project_id: string; pm_thread_id: string | null } | undefined;
}

/** The project's open run (pending or running), newest first. */
export function activeRunForProject(db: LanePilotDatabase, projectId: string): { id: string; pm_thread_id: string | null } | undefined {
  return db.prepare("SELECT id, pm_thread_id FROM lane_pilot_run WHERE project_id=? AND state IN ('pending','running') ORDER BY created_at DESC LIMIT 1")
    .get(projectId) as { id: string; pm_thread_id: string | null } | undefined;
}

/** Runs of a PM thread, most recently touched first. */
export function listRunsForPmThread(db: LanePilotDatabase, threadId: string, limit = 30): Array<{ id: string; project_id: string }> {
  return db.prepare("SELECT id, project_id FROM lane_pilot_run WHERE pm_thread_id=? ORDER BY updated_at DESC LIMIT ?")
    .all(threadId, limit) as Array<{ id: string; project_id: string }>;
}

/** The unclosed run a PM thread drives, newest first (the PM status bar's lookup). */
export function openRunOfPmThread(db: LanePilotDatabase, threadId: string): { id: string; project_id: string } | undefined {
  return db.prepare(
    "SELECT id, project_id FROM lane_pilot_run WHERE pm_thread_id=? AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1",
  ).get(threadId) as { id: string; project_id: string } | undefined;
}

/** The project's latest run on a PM thread, open or closed (a tool's "which run am I in" fallback). */
export function latestRunForProjectThread(db: LanePilotDatabase, projectId: string, pmThreadId: string): { id: string } | undefined {
  return db.prepare("SELECT id FROM lane_pilot_run WHERE project_id=? AND pm_thread_id=? ORDER BY created_at DESC LIMIT 1")
    .get(projectId, pmThreadId) as { id: string } | undefined;
}

/** Unclosed runs still pending or running (the abandoned-run sweep). */
export function listOpenLaneRuns(db: LanePilotDatabase): Array<{ id: string; project_id: string; pm_thread_id: string | null; created_at: number }> {
  return db.prepare("SELECT id,project_id,pm_thread_id,created_at FROM lane_pilot_run WHERE closed_at IS NULL AND state IN ('pending','running')")
    .all() as Array<{ id: string; project_id: string; pm_thread_id: string | null; created_at: number }>;
}

/** Unclosed runs marked running or blocked (the stale-run TTL sweep). */
export function listLiveRuns(db: LanePilotDatabase): Array<{ id: string; project_id: string; state: string; pm_thread_id: string | null; updated_at: number }> {
  return db.prepare("SELECT id, project_id, state, pm_thread_id, updated_at FROM lane_pilot_run WHERE closed_at IS NULL AND state IN ('running', 'blocked')")
    .all() as Array<{ id: string; project_id: string; state: string; pm_thread_id: string | null; updated_at: number }>;
}

/** Hosts that wrote a run recently (the fire drill calls each one). */
export function recentWriterHostIds(db: LanePilotDatabase, since: number): string[] {
  return (db.prepare("SELECT DISTINCT writer_host_id FROM lane_pilot_run WHERE writer_host_id IS NOT NULL AND created_at > ?")
    .all(since) as Array<{ writer_host_id: string }>).map((row) => row.writer_host_id);
}

/** The run card header: state, close time and the writer host a check log path resolves on. */
export function getRunCard(db: LanePilotDatabase, runId: string): { id: string; state: string; closed_at: number | null; writer_host_id: string | null } | undefined {
  return db.prepare("SELECT id, state, closed_at, writer_host_id FROM lane_pilot_run WHERE id=?")
    .get(runId) as { id: string; state: string; closed_at: number | null; writer_host_id: string | null } | undefined;
}

/** The PM thread of the project's newest open cli run, if one is open (a helper looks up the PM's model through it). */
export function pmThreadOfCliRun(db: LanePilotDatabase, projectId: string): string | null {
  return (db.prepare("SELECT pm_thread_id FROM lane_pilot_run WHERE kind='cli' AND project_id=? AND closed_at IS NULL AND pm_thread_id IS NOT NULL ORDER BY created_at DESC LIMIT 1")
    .get(projectId) as { pm_thread_id: string } | undefined)?.pm_thread_id ?? null;
}

/** The project's open cli runs that have a PM thread, newest first (a trigger finds the PM chat to report to). */
export function listOpenCliRuns(db: LanePilotDatabase, projectId: string): Array<{ id: string; pm_thread_id: string }> {
  return db.prepare("SELECT id, pm_thread_id FROM lane_pilot_run WHERE kind='cli' AND project_id=? AND closed_at IS NULL AND pm_thread_id IS NOT NULL ORDER BY created_at DESC LIMIT 20")
    .all(projectId) as Array<{ id: string; pm_thread_id: string }>;
}

/** The open run that merges into this folder, touched in the last day (a checkout guest is counted only under one). */
export function activeRunForWorkspacePath(db: LanePilotDatabase, path: string, since: number): { id: string; pmThreadId: string | null } | undefined {
  return db.prepare(`SELECT r.id, r.pm_thread_id AS pmThreadId FROM lane_pilot_run r
    WHERE r.closed_at IS NULL AND r.writer_workspace_path=? AND EXISTS(
      SELECT 1 FROM lane_pilot_attempt a WHERE a.run_id=r.id AND a.updated_at > ?)
    ORDER BY r.updated_at DESC LIMIT 1`).get(path, since) as { id: string; pmThreadId: string | null } | undefined;
}

/** Every run's id, project and creation time — the wiring sweeps scan the whole table. */
export function listAllRunRefs(db: LanePilotDatabase): Array<{ id: string; project_id: string; created_at: number }> {
  return db.prepare("SELECT id, project_id, created_at FROM lane_pilot_run").all() as Array<{ id: string; project_id: string; created_at: number }>;
}

/** A project's newest CLI PM chats touched since a time (the backlog scanner's PM lookup). */
export function listCliPmThreads(db: LanePilotDatabase, projectId: string, sinceMs: number): Array<{ pm_thread_id: string }> {
  return db.prepare("SELECT pm_thread_id FROM lane_pilot_run WHERE project_id=? AND kind='cli' AND pm_thread_id IS NOT NULL AND updated_at>=? ORDER BY updated_at DESC LIMIT 20")
    .all(projectId, sinceMs) as Array<{ pm_thread_id: string }>;
}

/** Projects with a CLI PM chat touched since a time (the backlog scanner's project list). */
export function listCliPmProjects(db: LanePilotDatabase, sinceMs: number): Array<{ project_id: string }> {
  return db.prepare("SELECT DISTINCT project_id FROM lane_pilot_run WHERE kind='cli' AND pm_thread_id IS NOT NULL AND updated_at>=?").all(sinceMs) as Array<{ project_id: string }>;
}

/** A project's runs that have a PM chat, newest first (the capability probe). */
export function listRunsWithPmThread(db: LanePilotDatabase, projectId: string): Array<{ id: string; pm_thread_id: string }> {
  return db.prepare("SELECT id, pm_thread_id FROM lane_pilot_run WHERE project_id=? AND pm_thread_id IS NOT NULL ORDER BY created_at DESC LIMIT 20").all(projectId) as Array<{ id: string; pm_thread_id: string }>;
}

/** PM thread ids of runs touched since a time (the replay harvest). */
export function listPmThreadIdsSince(db: LanePilotDatabase, sinceMs: number): string[] {
  return (db.prepare("SELECT pm_thread_id AS t FROM lane_pilot_run WHERE pm_thread_id IS NOT NULL AND updated_at>=?").all(sinceMs) as Array<{ t: string }>).map((row) => row.t);
}

/** PM thread ids the notice table names since a time (the replay harvest). */
export function listPmNoticeThreadIdsSince(db: LanePilotDatabase, sinceMs: number): string[] {
  return (db.prepare("SELECT DISTINCT pm_thread_id AS t FROM lane_pilot_pm_notice WHERE sent_at>=?").all(sinceMs) as Array<{ t: string }>).map((row) => row.t);
}

/** The first free placement claim on a run: host, workspace and environment land only on an unbound live run. */
export function claimRunPlacement(db: LanePilotDatabase, input: { hostId: string; workspacePath: string; environmentId: string; runId: string }): boolean {
  return db.prepare(`UPDATE lane_pilot_run
    SET writer_host_id=?, writer_workspace_path=?, writer_environment_id=?, updated_at=?
    WHERE id=? AND writer_host_id IS NULL AND writer_workspace_path IS NULL AND writer_environment_id IS NULL
      AND state IN ('pending','running')`)
    .run(input.hostId, input.workspacePath, input.environmentId, Date.now(), input.runId).changes === 1;
}

/** Every run's id, project, close time and last touch — cross-run sweeps (run goals) compare close order. */
export function listRunCloseRows(db: LanePilotDatabase): Array<{ id: string; project_id: string; closed_at: number | null; updated_at: number }> {
  return db.prepare("SELECT id, project_id, closed_at, updated_at FROM lane_pilot_run ORDER BY updated_at").all() as Array<{ id: string; project_id: string; closed_at: number | null; updated_at: number }>;
}

/** PM skill-use rows since a time (the skill-usage count). */
export function listPmSkillUsesSince(db: LanePilotDatabase, sinceMs: number): Array<{ skill: string; thread_id: string }> {
  return db.prepare("SELECT skill, thread_id FROM lane_pilot_pm_skill_use WHERE used_at>=?").all(sinceMs) as Array<{ skill: string; thread_id: string }>;
}

/** One PM skill-use row. */
export function recordPmSkillUse(db: LanePilotDatabase, row: { threadId: string; projectId: string; skill: string; at?: number }): void {
  db.prepare("INSERT INTO lane_pilot_pm_skill_use(thread_id,project_id,skill,used_at) VALUES(?,?,?,?)")
    .run(row.threadId, row.projectId, row.skill, row.at ?? Date.now());
}

/** The storage-owned half of the memory thread gate: does the thread appear in a run-table the plugin owns. */
export function pluginThreadInStoreTables(db: LanePilotDatabase, threadId: string): boolean {
  const row = db.prepare(`SELECT (
    EXISTS(SELECT 1 FROM lane_pilot_run WHERE pm_thread_id=?)
    OR EXISTS(SELECT 1 FROM lane_pilot_activation WHERE pm_thread_id=?)
    OR EXISTS(SELECT 1 FROM lane_pilot_attempt WHERE thread_id=? OR holder_thread_id=?)
    OR EXISTS(SELECT 1 FROM lane_pilot_stage_receipt WHERE thread_id=?)
    OR EXISTS(SELECT 1 FROM lane_pilot_pm_notice WHERE pm_thread_id=?)
    OR EXISTS(SELECT 1 FROM lane_pilot_pm_skill_use WHERE thread_id=?)
    OR EXISTS(SELECT 1 FROM lane_pilot_secret_issuance WHERE thread_id=?)
    OR EXISTS(SELECT 1 FROM lane_pilot_errand_episode WHERE thread_id=?)
  ) AS plugin`).get(threadId, threadId, threadId, threadId, threadId, threadId, threadId, threadId, threadId) as { plugin: number };
  return row.plugin === 1;
}

/** Whether any run of the project carries section scopes (the memory package's umbrella check, injected as a reader). */
export function projectHasScopedRun(db: { prepare: LanePilotDatabase["prepare"] }, projectId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM lane_pilot_run WHERE project_id=? AND settings_scopes_json LIKE '%section:%' LIMIT 1").get(projectId));
}

/** The storage-owned half of the silent-thread check (PM chat, activation, notice). */
export function silentThreadInStoreTables(db: LanePilotDatabase, threadId: string): boolean {
  const row = db.prepare(`SELECT (
    EXISTS(SELECT 1 FROM lane_pilot_run WHERE pm_thread_id=?)
    OR EXISTS(SELECT 1 FROM lane_pilot_activation WHERE pm_thread_id=?)
    OR EXISTS(SELECT 1 FROM lane_pilot_pm_notice WHERE pm_thread_id=?)
  ) AS silent`).get(threadId, threadId, threadId) as { silent: number };
  return row.silent === 1;
}

export function listActiveProjectIds(db: LanePilotDatabase, since: number): string[] {
  return (db.prepare("SELECT DISTINCT project_id FROM lane_pilot_run WHERE updated_at>=?").all(since) as Array<{ project_id: string }>).map((row) => row.project_id);
}

export function runPmThreadId(db: LanePilotDatabase, runId: string): string | null {
  return (db.prepare("SELECT pm_thread_id FROM lane_pilot_run WHERE id=?").get(runId) as { pm_thread_id: string | null } | undefined)?.pm_thread_id ?? null;
}

export function runProjectId(db: LanePilotDatabase, runId: string): string | null {
  return (db.prepare("SELECT project_id FROM lane_pilot_run WHERE id=?").get(runId) as { project_id: string } | undefined)?.project_id ?? null;
}

export function runClosedAt(db: LanePilotDatabase, runId: string): number | null {
  return (db.prepare("SELECT closed_at FROM lane_pilot_run WHERE id=?").get(runId) as { closed_at: number | null } | undefined)?.closed_at ?? null;
}

export function latestOpenPmThreadForProject(db: LanePilotDatabase, projectId: string): string | null {
  return (db.prepare("SELECT pm_thread_id FROM lane_pilot_run WHERE project_id=? AND closed_at IS NULL AND pm_thread_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1")
    .get(projectId) as { pm_thread_id: string } | undefined)?.pm_thread_id ?? null;
}

export function runIdForPmThread(db: LanePilotDatabase, threadId: string): string | null {
  return (db.prepare("SELECT id FROM lane_pilot_run WHERE pm_thread_id=? LIMIT 1").get(threadId) as { id: string } | undefined)?.id ?? null;
}

export function latestRunIdForPmThread(db: LanePilotDatabase, threadId: string): string | null {
  return (db.prepare("SELECT id FROM lane_pilot_run WHERE pm_thread_id=? ORDER BY created_at DESC LIMIT 1").get(threadId) as { id: string } | undefined)?.id ?? null;
}

export function openRunIdForPmThread(db: LanePilotDatabase, threadId: string): string | null {
  return (db.prepare("SELECT id FROM lane_pilot_run WHERE pm_thread_id=? AND closed_at IS NULL LIMIT 1").get(threadId) as { id: string } | undefined)?.id ?? null;
}

export function projectIdForPmThread(db: LanePilotDatabase, threadId: string): string | null {
  return (db.prepare("SELECT project_id FROM lane_pilot_run WHERE pm_thread_id=? LIMIT 1").get(threadId) as { project_id: string } | undefined)?.project_id ?? null;
}

export function runStateCounts(db: LanePilotDatabase, projectId: string): Record<string, number> {
  return Object.fromEntries((db.prepare("SELECT state, COUNT(*) AS n FROM lane_pilot_run WHERE project_id=? GROUP BY state")
    .all(projectId) as Array<{ state: string; n: number }>).map((row) => [row.state, row.n]));
}

export function latestAreaWriterBinding(db: LanePilotDatabase, projectId: string, area: string): { hostId: string | null; path: string | null } | undefined {
  return db.prepare(`SELECT r.writer_host_id AS hostId, r.writer_workspace_path AS path FROM lane_pilot_run r JOIN lane_pilot_task t ON t.run_id=r.id
    WHERE r.project_id=? AND r.writer_workspace_path IS NOT NULL AND r.writer_host_id IS NOT NULL AND COALESCE(json_extract(t.contract_json,'$.area'),'')=?
    ORDER BY r.updated_at DESC LIMIT 1`).get(projectId, area) as { hostId: string | null; path: string | null } | undefined;
}

export function listRunIdsForProject(db: LanePilotDatabase, projectId: string): string[] {
  return (db.prepare("SELECT id FROM lane_pilot_run WHERE project_id=?").all(projectId) as Array<{ id: string }>).map((row) => row.id);
}
