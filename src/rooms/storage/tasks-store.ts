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
