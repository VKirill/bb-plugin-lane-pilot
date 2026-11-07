import { isAbsolute, relative, resolve } from "node:path";
import { OPEN_ATTEMPT_STATES } from "../state-machine";
import type { LanePilotDatabase } from "./database";
import { getRun } from "./runs-store";

export function createTask(
  db: LanePilotDatabase,
  ids: { id:string; runId:string; kind:"bb"|"cli"; contract:unknown; birth?:string },
): void {
  db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at,birth) VALUES (?,?,?,?,?,?)")
    .run(ids.id, ids.runId, ids.kind, JSON.stringify(ids.contract), Date.now(), ids.birth ?? "pm");
}

export function updateTaskContract(
  db: LanePilotDatabase,
  taskId: string,
  contract: unknown,
): boolean {
  const result = db.prepare("UPDATE lane_pilot_task SET contract_json=? WHERE id=?")
    .run(JSON.stringify(contract), taskId);
  return result.changes > 0;
}

export function getTask(db: LanePilotDatabase, taskId: string): {
  id:string; run_id:string; kind:"bb"|"cli"; contract:unknown;
}|undefined {
  const row = db.prepare("SELECT id,run_id,kind,contract_json FROM lane_pilot_task WHERE id=?").get(taskId) as
    {id:string; run_id:string; kind:"bb"|"cli"; contract_json:string}|undefined;
  return row ? { id:row.id, run_id:row.run_id, kind:row.kind, contract:JSON.parse(row.contract_json) } : undefined;
}

/**
 * The checkout a task works in: its contract's project_cwd when that is the run's folder or a folder inside it (a task
 * dispatch moved into a git repository of a run folder without git), else the run's folder.
 */
export function taskBasePath(db: LanePilotDatabase, runId: string, taskId: string): string | null {
  return checkoutBase(getRun(db, runId)?.writer_workspace_path ?? null, (getTask(db, taskId)?.contract as { project_cwd?: unknown } | undefined)?.project_cwd);
}

/** taskBasePath of a contract not saved yet: its project_cwd inside the run's folder, else the run's folder. */
export function checkoutBase(runPath: string | null, cwd: unknown): string | null {
  if (!runPath || typeof cwd !== "string") return runPath;
  const rel = relative(resolve(runPath), resolve(cwd));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? cwd : runPath;
}

export function saveTaskGitBase(db:LanePilotDatabase,taskId:string,base:{baseRef:string|null;baseSha:string|null;initialHeadSha:string;branch:string;compareCommitted:boolean}):boolean {
  if(!/^[a-f0-9]{40,64}$/.test(base.initialHeadSha)||!base.branch||base.branch.length>240
    ||(base.baseSha!==null&&!/^[a-f0-9]{40,64}$/.test(base.baseSha))) return false;
  const changed=db.prepare(`INSERT INTO lane_pilot_task_git_base(task_id,base_ref,base_sha,initial_head_sha,branch,compare_committed,captured_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(task_id) DO NOTHING`)
    .run(taskId,base.baseRef,base.baseSha,base.initialHeadSha,base.branch,base.compareCommitted?1:0,Date.now()).changes;
  return changed===1;
}

export function getTaskGitBase(db:LanePilotDatabase,taskId:string):{base_ref:string|null;base_sha:string|null;initial_head_sha:string;branch:string;compare_committed:boolean}|undefined {
  const row=db.prepare("SELECT base_ref,base_sha,initial_head_sha,branch,compare_committed FROM lane_pilot_task_git_base WHERE task_id=?").get(taskId) as
    {base_ref:string|null;base_sha:string|null;initial_head_sha:string;branch:string;compare_committed:number}|undefined;
  return row?{...row,compare_committed:row.compare_committed===1}:undefined;
}

export function listTasksForRun(db: LanePilotDatabase, runId:string):Array<{
  id:string; run_id:string; kind:"bb"|"cli"; contract:unknown;
}> {
  const rows = db.prepare("SELECT id,run_id,kind,contract_json FROM lane_pilot_task WHERE run_id=? ORDER BY id")
    .all(runId) as Array<{id:string;run_id:string;kind:"bb"|"cli";contract_json:string}>;
  return rows.map((row) => ({ id:row.id, run_id:row.run_id, kind:row.kind, contract:JSON.parse(row.contract_json) }));
}

/** Tasks that still hold their owned paths: one with an attempt at work, or one still in preflight.
 * Accepted work is already in the run's base checkout, and a task whose attempts ended or whose
 * preflight failed or was blocked holds none, so a later task or a retry may take its paths. */
export function listLiveTasksForRun(db: LanePilotDatabase, runId:string): ReturnType<typeof listTasksForRun> {
  return listTasksForRun(db, runId).filter((task) => {
    const states = (db.prepare("SELECT state FROM lane_pilot_attempt WHERE run_id=? AND task_id=?").all(runId, task.id) as Array<{state:string}>)
      .map((row) => row.state);
    if (states.length) return states.some((state) => (OPEN_ATTEMPT_STATES as readonly string[]).includes(state));
    return !db.prepare("SELECT 1 FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=? AND state IN ('blocked','failed') LIMIT 1").get(runId, task.id);
  });
}

/** Task ids are global keys; a repeated id gets the first free `id.N`, so a retry never collides. */
export function freeTaskId(db: LanePilotDatabase, id:string): string {
  const taken = (candidate:string) => Boolean(db.prepare("SELECT 1 FROM lane_pilot_task WHERE id=?").get(candidate));
  if (!taken(id)) return id;
  for (let n = 2; ; n++) if (!taken(`${id}.${n}`)) return `${id}.${n}`;
}

export function saveTaskPlan(db: LanePilotDatabase, taskId:string, plan:string): void {
  db.prepare(`INSERT INTO lane_pilot_task_plan(task_id,plan) VALUES(?,?)
    ON CONFLICT(task_id) DO UPDATE SET plan=excluded.plan`).run(taskId, plan);
}

export function getTaskPlan(db: LanePilotDatabase, taskId:string): string|null {
  const row = db.prepare("SELECT plan FROM lane_pilot_task_plan WHERE task_id=?").get(taskId) as {plan:string}|undefined;
  return row?.plan ?? null;
}

export function listTaskKinds(db: LanePilotDatabase, runId: string): Array<"bb"|"cli"> {
  return (db.prepare("SELECT kind FROM lane_pilot_task WHERE run_id=?").all(runId) as Array<{kind:"bb"|"cli"}>)
    .map((row) => row.kind);
}

/** The PM's closing words on a canceled task (lane_pilot_cancel_task words). */
export function setTaskClosedWords(db: LanePilotDatabase, taskId: string, words: string): void {
  db.prepare("UPDATE lane_pilot_task SET closed_words=? WHERE id=?").run(words, taskId);
}

/** The date a queued task is held until (HOLD_FOREVER = until released); null when it is not held. */
export function taskHeldUntil(db: LanePilotDatabase, taskId: string): number | null {
  return (db.prepare("SELECT held_until FROM lane_pilot_task WHERE id=?").get(taskId) as { held_until: number | null } | undefined)?.held_until ?? null;
}

/** Hold or release a task of a run; false when the task is not of this run. */
export function setTaskHeldUntil(db: LanePilotDatabase, taskId: string, runId: string, until: number | null): boolean {
  return Boolean(db.prepare("UPDATE lane_pilot_task SET held_until=? WHERE id=? AND run_id=?").run(until, taskId, runId).changes);
}

/** The stored contract JSON of a task, optionally checked against its run. */
export function getTaskContractJson(db: LanePilotDatabase, taskId: string, runId?: string): string | null {
  const row = (runId === undefined
    ? db.prepare("SELECT contract_json FROM lane_pilot_task WHERE id=?").get(taskId)
    : db.prepare("SELECT contract_json FROM lane_pilot_task WHERE id=? AND run_id=?").get(taskId, runId)) as { contract_json: string } | undefined;
  return row?.contract_json ?? null;
}

/** Rewrite a task's stored contract JSON in place. */
export function updateTaskContractJson(db: LanePilotDatabase, taskId: string, runId: string, contractJson: string): void {
  db.prepare("UPDATE lane_pilot_task SET contract_json=? WHERE id=? AND run_id=?").run(contractJson, taskId, runId);
}

/** A task's row under its run (the PM's dispatch dedupe reads it). */
export function getTaskRow(db: LanePilotDatabase, taskId: string, runId: string): { contract_json: string; created_at: number } | undefined {
  return db.prepare("SELECT contract_json, created_at FROM lane_pilot_task WHERE id=? AND run_id=?").get(taskId, runId) as
    { contract_json: string; created_at: number } | undefined;
}

/** Every task row of a run with its stored contract, birth and dispatch time. */
export function listRunTaskRows(db: LanePilotDatabase, runId: string): Array<{ id: string; contract_json: string; created_at: number; birth: string | null }> {
  return db.prepare("SELECT id, contract_json, created_at, birth FROM lane_pilot_task WHERE run_id=?").all(runId) as
    Array<{ id: string; contract_json: string; created_at: number; birth: string | null }>;
}

/** The task ids of a run. */
export function listTaskIdsForRun(db: LanePilotDatabase, runId: string): string[] {
  return (db.prepare("SELECT id FROM lane_pilot_task WHERE run_id=?").all(runId) as Array<{ id: string }>).map((row) => row.id);
}

/** The run's board: each task with its display or technical title and its latest attempt's state. */
export function listRunTaskSummaries(db: LanePilotDatabase, runId: string, limit = 60): Array<{ taskId: string; title: string; state: string | null }> {
  return db.prepare(`SELECT t.id AS taskId, COALESCE(json_extract(t.contract_json,'$.display_title'), json_extract(t.contract_json,'$.title')) AS title,
    (SELECT a.state FROM lane_pilot_attempt a WHERE a.task_id=t.id ORDER BY a.created_at DESC LIMIT 1) AS state
    FROM lane_pilot_task t WHERE t.run_id=? ORDER BY t.created_at DESC LIMIT ?`).all(runId, limit) as
    Array<{ taskId: string; title: string; state: string | null }>;
}
