import type { StageId, StageState } from "@lane-pilot/contracts";
import type { LanePilotDatabase } from "./database";

export type StageReceiptRow = {
  runId:string; taskId:string; stageId:StageId; contractVersion:1;
  state:StageState;
  inputSha256:string; outputSha256:string|null; attempt:number;
  providerId:string|null; model:string|null; threadId:string|null;
  result:unknown|null; reason:string|null; updatedAt:number;
};

/** One caller may spawn the child; others observe. Crash after this flag is reconcile-only. */
export function claimStageSpawn(db: LanePilotDatabase, runId:string, taskId:string, stageId:StageId): boolean {
  return db.transaction(() => {
    const row = db.prepare(`SELECT state,thread_id,result_json FROM lane_pilot_stage_receipt
      WHERE run_id=? AND task_id=? AND stage_id=?`).get(runId, taskId, stageId) as
      {state:StageState;thread_id:string|null;result_json:string|null}|undefined;
    if (!row || row.state !== "running" || row.thread_id) return false;
    let result: Record<string, unknown> = {};
    if (row.result_json) {
      const parsed = JSON.parse(row.result_json) as unknown;
      if (parsed && typeof parsed === "object") result = parsed as Record<string, unknown>;
    }
    if (result.spawnAttempted === true) return false;
    const next = JSON.stringify({ ...result, spawnAttempted:true });
    return db.prepare(`UPDATE lane_pilot_stage_receipt SET result_json=?, updated_at=?
      WHERE run_id=? AND task_id=? AND stage_id=? AND state='running' AND thread_id IS NULL
        AND (result_json IS NULL OR json_extract(result_json,'$.spawnAttempted') IS NOT 1)`)
      .run(next, Date.now(), runId, taskId, stageId).changes === 1;
  }).immediate();
}

export function claimDocsSpawn(db: LanePilotDatabase, runId:string, taskId:string): boolean {
  return claimStageSpawn(db, runId, taskId, "docs-maintenance");
}

export function saveStageReceipt(db: LanePilotDatabase, row:StageReceiptRow): void {
  const { result, ...fields } = row;
  db.transaction(() => {
    const previous = db.prepare("SELECT state,input_sha256,output_sha256,attempt FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=? AND stage_id=?")
      .get(row.runId,row.taskId,row.stageId) as {state:StageState;input_sha256:string;output_sha256:string|null;attempt:number}|undefined;
    // input_sha256 follows the latest record: a stage replaced on a new input is compared with that input, not with its first one.
    db.prepare(`INSERT INTO lane_pilot_stage_receipt
    (run_id,task_id,stage_id,contract_version,state,input_sha256,output_sha256,attempt,provider_id,model,thread_id,result_json,reason,updated_at)
    VALUES (@runId,@taskId,@stageId,@contractVersion,@state,@inputSha256,@outputSha256,@attempt,@providerId,@model,@threadId,@resultJson,@reason,@updatedAt)
    ON CONFLICT(run_id,task_id,stage_id) DO UPDATE SET state=excluded.state,input_sha256=excluded.input_sha256,
      output_sha256=excluded.output_sha256,attempt=excluded.attempt,provider_id=excluded.provider_id,
      model=excluded.model,thread_id=excluded.thread_id,result_json=excluded.result_json,
      reason=excluded.reason,updated_at=excluded.updated_at`).run({
        ...fields, resultJson:result === null ? null : JSON.stringify(result),
      });
    if (!previous || previous.state !== row.state || previous.input_sha256 !== row.inputSha256 ||
        previous.output_sha256 !== row.outputSha256 || previous.attempt !== row.attempt) {
      const run = db.prepare("SELECT project_id FROM lane_pilot_run WHERE id=?").get(row.runId) as {project_id:string}|undefined;
      if (!run) throw new Error("stage event run is missing");
      db.prepare(`INSERT INTO lane_pilot_stage_event
        (project_id,run_id,task_id,stage_id,state,input_sha256,output_sha256,attempt,occurred_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(run.project_id,row.runId,row.taskId,row.stageId,row.state,
          row.inputSha256,row.outputSha256,row.attempt,row.updatedAt);
    }
  }).immediate();
}

/** Removes a stage's current receipt so the stage runs again from nothing; its events stay in lane_pilot_stage_event. */
export function deleteStageReceipt(db: LanePilotDatabase, runId:string, taskId:string, stageId:StageId): boolean {
  return db.prepare("DELETE FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=? AND stage_id=?").run(runId, taskId, stageId).changes > 0;
}

export type StageEventRow = {
  id:number; projectId:string; runId:string; taskId:string; stageId:StageId; state:StageState;
  inputSha256:string; outputSha256:string|null; attempt:number; occurredAt:number;
};

export const GATE_CATEGORIES = ["owns-paths","validate","accept","verification"] as const;
export type GateCategory = (typeof GATE_CATEGORIES)[number];
export type GateEventStatus = "passed"|"rejected"|"failed"|"skipped";
export type GateEventRow = {
  id:number; projectId:string; runId:string; taskId:string; gate:GateCategory; status:GateEventStatus;
  inputSha256:string; outputSha256:string|null; attempt:number; occurredAt:number;
};

export function appendGateEvaluation(db:LanePilotDatabase,row:Omit<GateEventRow,"id">):void {
  db.prepare(`INSERT INTO lane_pilot_gate_event
    (project_id,run_id,task_id,gate,status,input_sha256,output_sha256,attempt,occurred_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(row.projectId,row.runId,row.taskId,row.gate,row.status,
      row.inputSha256,row.outputSha256,row.attempt,row.occurredAt);
}

export function listGateEvents(db:LanePilotDatabase,input:{projectId:string;since:number;gate?:GateCategory}):GateEventRow[] {
  const rows=input.gate
    ? db.prepare("SELECT * FROM lane_pilot_gate_event WHERE project_id=? AND occurred_at>=? AND gate=? ORDER BY occurred_at,id").all(input.projectId,input.since,input.gate)
    : db.prepare("SELECT * FROM lane_pilot_gate_event WHERE project_id=? AND occurred_at>=? ORDER BY occurred_at,id").all(input.projectId,input.since);
  return (rows as Array<Record<string,unknown>>).map((row)=>({
    id:row.id as number,projectId:row.project_id as string,runId:row.run_id as string,taskId:row.task_id as string,
    gate:row.gate as GateCategory,status:row.status as GateEventStatus,inputSha256:row.input_sha256 as string,
    outputSha256:row.output_sha256 as string|null,attempt:row.attempt as number,occurredAt:row.occurred_at as number,
  }));
}

export function listStageEvents(db:LanePilotDatabase,input:{projectId:string;since:number;stageId?:StageId}):StageEventRow[] {
  const rows = input.stageId
    ? db.prepare(`SELECT * FROM lane_pilot_stage_event WHERE project_id=? AND occurred_at>=? AND stage_id=? ORDER BY occurred_at,id`)
      .all(input.projectId,input.since,input.stageId)
    : db.prepare(`SELECT * FROM lane_pilot_stage_event WHERE project_id=? AND occurred_at>=? ORDER BY occurred_at,id`)
      .all(input.projectId,input.since);
  return (rows as Array<Record<string,unknown>>).map((row)=>({
    id:row.id as number,projectId:row.project_id as string,runId:row.run_id as string,taskId:row.task_id as string,
    stageId:row.stage_id as StageId,state:row.state as StageState,inputSha256:row.input_sha256 as string,
    outputSha256:row.output_sha256 as string|null,attempt:row.attempt as number,occurredAt:row.occurred_at as number,
  }));
}

export function listStageReceipts(db:LanePilotDatabase, runId:string, taskId?:string): StageReceiptRow[] {
  const rows = taskId
    ? db.prepare("SELECT * FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=? ORDER BY stage_id").all(runId, taskId)
    : db.prepare("SELECT * FROM lane_pilot_stage_receipt WHERE run_id=? ORDER BY task_id,stage_id").all(runId);
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    runId:row.run_id as string, taskId:row.task_id as string, stageId:row.stage_id as StageId,
    contractVersion:row.contract_version as 1, state:row.state as StageState,
    inputSha256:row.input_sha256 as string, outputSha256:row.output_sha256 as string|null,
    attempt:row.attempt as number, providerId:row.provider_id as string|null, model:row.model as string|null,
    threadId:row.thread_id as string|null, result:row.result_json == null ? null : JSON.parse(row.result_json as string),
    reason:row.reason as string|null, updatedAt:row.updated_at as number,
  }));
}

/** The stage rows of a run without their result bodies: the screen lists these and loads one body only when it is opened. */
export function listStageReceiptSummaries(db:LanePilotDatabase, runId:string): Array<Omit<StageReceiptRow,"result"> & {hasResult:boolean}> {
  const rows = db.prepare(`SELECT run_id,task_id,stage_id,contract_version,state,input_sha256,output_sha256,attempt,provider_id,model,thread_id,
    (result_json IS NOT NULL) AS has_result,reason,updated_at FROM lane_pilot_stage_receipt WHERE run_id=? ORDER BY task_id,stage_id`).all(runId);
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    runId:row.run_id as string, taskId:row.task_id as string, stageId:row.stage_id as StageId,
    contractVersion:row.contract_version as 1, state:row.state as StageState,
    inputSha256:row.input_sha256 as string, outputSha256:row.output_sha256 as string|null,
    attempt:row.attempt as number, providerId:row.provider_id as string|null, model:row.model as string|null,
    threadId:row.thread_id as string|null, hasResult:Boolean(row.has_result),
    reason:row.reason as string|null, updatedAt:row.updated_at as number,
  }));
}

export function countStageReceipts(db:LanePilotDatabase, runId:string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_stage_receipt WHERE run_id=?").get(runId) as {n:number}).n;
}

/** One stage's result body, parsed; `found` tells a missing row from a row without a result. */
export function getStageReceiptResult(db:LanePilotDatabase, runId:string, taskId:string, stageId:string): {found:boolean; result:unknown|null} {
  const row = db.prepare("SELECT result_json FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=? AND stage_id=?").get(runId, taskId, stageId) as {result_json:string|null}|undefined;
  if (!row) return { found:false, result:null };
  return { found:true, result:row.result_json == null ? null : JSON.parse(row.result_json) };
}

/** Background stages a reload interrupted: still pending or running, with the PM thread that owns them. */
export function listUnfinishedStages(db:LanePilotDatabase, stageIds:StageId[]): Array<{runId:string;taskId:string;stageId:StageId;projectId:string;pmThreadId:string}> {
  if(!stageIds.length) return [];
  const rows=db.prepare(`SELECT s.run_id,s.task_id,s.stage_id,r.project_id,r.pm_thread_id FROM lane_pilot_stage_receipt s JOIN lane_pilot_run r ON r.id=s.run_id
    WHERE s.state IN ('pending','running') AND r.pm_thread_id IS NOT NULL AND s.stage_id IN (${stageIds.map(()=>"?").join(",")}) ORDER BY s.updated_at`).all(...stageIds) as Array<Record<string,string>>;
  return rows.map((row)=>({runId:row.run_id!,taskId:row.task_id!,stageId:row.stage_id as StageId,projectId:row.project_id!,pmThreadId:row.pm_thread_id!}));
}

/** A stage receipt that ended rejected (blocked or failed) for the task of a run. */
export function hasFailedStageReceipt(db: LanePilotDatabase, runId: string, taskId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=? AND state IN ('blocked','failed') LIMIT 1").get(runId, taskId));
}

/** The task's stage events in order. */
export function stageEventsForTask(db: LanePilotDatabase, runId: string, taskId: string): Array<{ stage_id: string; state: string; occurred_at: number }> {
  return db.prepare("SELECT stage_id, state, occurred_at FROM lane_pilot_stage_event WHERE run_id=? AND task_id=? ORDER BY id")
    .all(runId, taskId) as Array<{ stage_id: string; state: string; occurred_at: number }>;
}

/** Run/task keys that had a stage event since a time, newest activity first. */
export function stageEventKeysSince(db: LanePilotDatabase, sinceMs: number, projectId?: string): Array<{ run_id: string; task_id: string; project_id: string; at: number }> {
  return db.prepare(`SELECT run_id, task_id, project_id, max(occurred_at) AS at FROM lane_pilot_stage_event
    WHERE occurred_at >= ? ${projectId ? "AND project_id = ?" : ""} GROUP BY run_id, task_id ORDER BY at DESC`)
    .all(sinceMs, ...(projectId ? [projectId] : [])) as Array<{ run_id: string; task_id: string; project_id: string; at: number }>;
}

/** Run/task pairs with a receipt in the given stage/state sets (the orphan-stage sweep). */
export function listOpenStageTasks(db: LanePilotDatabase, stageIds: readonly string[], states: readonly string[]): Array<{ run_id: string; task_id: string }> {
  return db.prepare(`SELECT DISTINCT s.run_id, s.task_id FROM lane_pilot_stage_receipt s
    WHERE s.stage_id IN (${stageIds.map(() => "?").join(",")}) AND s.state IN (${states.map(() => "?").join(",")})`)
    .all(...stageIds, ...states) as Array<{ run_id: string; task_id: string }>;
}

/** One stage receipt's state, thread and last touch. */
export function stageReceiptState(db: LanePilotDatabase, runId: string, taskId: string, stageId: string): { state: string; thread_id: string | null; updated_at: number } | undefined {
  return db.prepare("SELECT state, thread_id, updated_at FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=? AND stage_id=?")
    .get(runId, taskId, stageId) as { state: string; thread_id: string | null; updated_at: number } | undefined;
}

/** The work a thread last ran as a stage worker, with its run's project and PM thread (the info panel's helper card). */
export function latestStageWorkForThread(db: LanePilotDatabase, threadId: string): { run_id: string; task_id: string; project_id: string; pm_thread_id: string | null } | undefined {
  return db.prepare(`SELECT s.run_id, s.task_id, r.project_id, r.pm_thread_id FROM lane_pilot_stage_receipt s JOIN lane_pilot_run r ON r.id=s.run_id
    WHERE s.thread_id=? ORDER BY s.updated_at DESC LIMIT 1`).get(threadId) as
    { run_id: string; task_id: string; project_id: string; pm_thread_id: string | null } | undefined;
}

/** Stage receipts of one stage still running and last touched before a time (a reload resumes them). */
export function staleStageReceipts(db: LanePilotDatabase, stageId: string, updatedBefore: number): Array<{ run_id: string; task_id: string }> {
  return db.prepare(`SELECT run_id, task_id FROM lane_pilot_stage_receipt WHERE stage_id=? AND state='running' AND updated_at < ?`)
    .all(stageId, updatedBefore) as Array<{ run_id: string; task_id: string }>;
}

/** Receipt rows whose result mentions a check log path (the run card links each to its host file). */
export function taskCheckLogRows(db: LanePilotDatabase, runId: string): Array<{ task_id: string; result_json: string | null }> {
  return db.prepare("SELECT task_id, result_json FROM lane_pilot_stage_receipt WHERE run_id=? AND result_json LIKE '%checkLogPath%'")
    .all(runId) as Array<{ task_id: string; result_json: string | null }>;
}

/** Failed or blocked background stages of the run (the card shows them next to an accepted task, not under it). */
export function failedBackgroundStageRows(db: LanePilotDatabase, runId: string): Array<{ task_id: string; stage_id: string }> {
  return db.prepare(`SELECT task_id, stage_id FROM lane_pilot_stage_receipt WHERE run_id=? AND state IN ('failed','blocked')
    AND stage_id IN ('memory-maintenance','project-life','docs-maintenance') ORDER BY stage_id`).all(runId) as Array<{ task_id: string; stage_id: string }>;
}

/** The task's stage events, oldest first (the task timeline's stage lines). */
export function stageEventsForTimeline(db: LanePilotDatabase, runId: string, taskId: string): Array<{ stage_id: string; state: string; attempt: number; occurred_at: number }> {
  return db.prepare("SELECT stage_id, state, attempt, occurred_at FROM lane_pilot_stage_event WHERE run_id=? AND task_id=? ORDER BY occurred_at, id")
    .all(runId, taskId) as Array<{ stage_id: string; state: string; attempt: number; occurred_at: number }>;
}

/** The task's gate events, oldest first (the task timeline's gate lines). */
export function gateEventsForTask(db: LanePilotDatabase, runId: string, taskId: string): Array<{ gate: string; status: string; attempt: number; occurred_at: number }> {
  return db.prepare("SELECT gate, status, attempt, occurred_at FROM lane_pilot_gate_event WHERE run_id=? AND task_id=? ORDER BY occurred_at, id")
    .all(runId, taskId) as Array<{ gate: string; status: string; attempt: number; occurred_at: number }>;
}

/** The task's receipts by last touch (the task timeline's "stages now" block). */
export function stageReceiptsForTimeline(db: LanePilotDatabase, runId: string, taskId: string): Array<{ stage_id: string; state: string; attempt: number; reason: string | null; updated_at: number }> {
  return db.prepare("SELECT stage_id, state, attempt, reason, updated_at FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=? ORDER BY updated_at")
    .all(runId, taskId) as Array<{ stage_id: string; state: string; attempt: number; reason: string | null; updated_at: number }>;
}

/** Verification gate failures/rejections of the task (the max-passes cap counts them). */
export function countVerificationGateFailures(db: LanePilotDatabase, runId: string, taskId: string): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM lane_pilot_gate_event WHERE run_id=? AND task_id=? AND gate='verification' AND status IN ('failed','rejected')",
  ).get(runId, taskId) as { n: number }).n;
}

/** Stage/state pairs of a task's receipts (the PM status phase guess needs no result bodies). */
export function stageReceiptStates(db: LanePilotDatabase, runId: string, taskId: string): Array<{ stage_id: string; state: string }> {
  return db.prepare("SELECT stage_id, state FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=?")
    .all(runId, taskId) as Array<{ stage_id: string; state: string }>;
}

/** One receipt's state and attempt (a recheck decides from those alone). */
export function stageReceiptAttemptState(db: LanePilotDatabase, runId: string, taskId: string, stageId: string): { state: string; attempt: number } | undefined {
  return db.prepare("SELECT state, attempt FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=? AND stage_id=?")
    .get(runId, taskId, stageId) as { state: string; attempt: number } | undefined;
}

/** A task's gate evaluations in order (the acceptance card). */
export function listGateEventsForTask(db: LanePilotDatabase, runId: string, taskId: string): Array<{ gate: string; status: string; attempt: number; occurred_at: number }> {
  return db.prepare("SELECT gate, status, attempt, occurred_at FROM lane_pilot_gate_event WHERE run_id=? AND task_id=? ORDER BY id").all(runId, taskId) as
    Array<{ gate: string; status: string; attempt: number; occurred_at: number }>;
}

/** The newest touch of a stage receipt of a project, ignoring one state (the memory recurrence check). */
export function lastStageReceiptAt(db: LanePilotDatabase, projectId: string, stageId: string, notState: string): number {
  return ((db.prepare(`SELECT MAX(s.updated_at) AS at FROM lane_pilot_stage_receipt s JOIN lane_pilot_run r ON r.id=s.run_id
    WHERE r.project_id=? AND s.stage_id=? AND s.state<>?`).get(projectId, stageId, notState) as { at: number | null }).at) ?? 0;
}

/** Count of stage receipts of a project in one state since a time (the memory recurrence check). */
export function countStageReceiptsSince(db: LanePilotDatabase, projectId: string, stageId: string, state: string, sinceMs: number): number {
  return (db.prepare(`SELECT count(*) AS n FROM lane_pilot_stage_receipt s JOIN lane_pilot_run r ON r.id=s.run_id
    WHERE r.project_id=? AND s.stage_id=? AND s.state=? AND s.updated_at>?`).get(projectId, stageId, state, sinceMs) as { n: number }).n;
}

/** Stage events of a project since a time, optionally one task's, in insertion order (the metrics report). */
export function listProjectStageEventsSince(db: LanePilotDatabase, input: { projectId: string; sinceMs: number; taskId?: string }): Array<{ run_id: string; task_id: string; stage_id: string; state: string; occurred_at: number }> {
  return db.prepare(`SELECT run_id, task_id, stage_id, state, occurred_at FROM lane_pilot_stage_event
    WHERE project_id = ? AND occurred_at >= ? ${input.taskId ? "AND task_id = ?" : ""} ORDER BY id`)
    .all(input.projectId, input.sinceMs, ...(input.taskId ? [input.taskId] : [])) as
    Array<{ run_id: string; task_id: string; stage_id: string; state: string; occurred_at: number }>;
}

/** Gate events of a project since a time, optionally one task's, in insertion order (the metrics report). */
export function listProjectGateEventsSince(db: LanePilotDatabase, input: { projectId: string; sinceMs: number; taskId?: string }): Array<{ run_id: string; task_id: string; status: string; occurred_at: number }> {
  return db.prepare(`SELECT run_id, task_id, status, occurred_at FROM lane_pilot_gate_event
    WHERE project_id = ? AND occurred_at >= ? ${input.taskId ? "AND task_id = ?" : ""} ORDER BY id`)
    .all(input.projectId, input.sinceMs, ...(input.taskId ? [input.taskId] : [])) as
    Array<{ run_id: string; task_id: string; status: string; occurred_at: number }>;
}

/** provider/model of one stage receipt (the metrics report's writer card). */
export function stageReceiptProviderModel(db: LanePilotDatabase, runId: string, taskId: string, stageId: string): { provider_id: string | null; model: string | null } | undefined {
  return db.prepare("SELECT provider_id, model FROM lane_pilot_stage_receipt WHERE run_id = ? AND task_id = ? AND stage_id = ?")
    .get(runId, taskId, stageId) as { provider_id: string | null; model: string | null } | undefined;
}

/** One stage receipt's state and raw result JSON (the jev CLI's plan-fact comparison). */
export function stageReceiptStateResultJson(db: LanePilotDatabase, runId: string, taskId: string, stageId: string): { state: string; result_json: string | null } | undefined {
  return db.prepare("SELECT state, result_json FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=? AND stage_id=?")
    .get(runId, taskId, stageId) as { state: string; result_json: string | null } | undefined;
}

export function latestStageResultJson(db: LanePilotDatabase, runId: string, taskId: string, stageId: string): string | null {
  return (db.prepare("SELECT result_json FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=? AND stage_id=? ORDER BY updated_at DESC LIMIT 1")
    .get(runId, taskId, stageId) as { result_json: string | null } | undefined)?.result_json ?? null;
}

export function listStageReceiptsForProject(db: LanePilotDatabase, projectId: string, stageId: string, since: number): Array<{ task_id: string; state: string; decision: string | null; model: string }> {
  return db.prepare(`SELECT s.task_id, s.state, json_extract(s.result_json,'$.decision') decision,
      COALESCE(NULLIF(s.model,''), json_extract(s.result_json,'$.reviewer.model'), 'unknown') model
    FROM lane_pilot_stage_receipt s JOIN lane_pilot_run r ON r.id=s.run_id WHERE r.project_id=? AND s.stage_id=? AND s.updated_at>=?`)
    .all(projectId, stageId, since) as Array<{ task_id: string; state: string; decision: string | null; model: string }>;
}

export function listReviewStageRows(db: LanePilotDatabase, runId: string, taskId: string): Array<{ stage_id: string; state: string; reason: string | null; result_json: string | null }> {
  return db.prepare(`SELECT stage_id, state, reason, result_json FROM lane_pilot_stage_receipt
    WHERE run_id=? AND task_id=? AND stage_id IN ('plan-critique','code-critique','night-review','verification')`)
    .all(runId, taskId) as Array<{ stage_id: string; state: string; reason: string | null; result_json: string | null }>;
}

export function listFailedStageReceipts(db: LanePilotDatabase, runId: string, taskId: string): Array<{ stage_id: string; state: string; reason: string | null }> {
  return db.prepare("SELECT stage_id, state, reason FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=? AND state IN ('failed','blocked')")
    .all(runId, taskId) as Array<{ stage_id: string; state: string; reason: string | null }>;
}

export function listStageReceiptStates(db: LanePilotDatabase, runId: string, taskId: string): Array<{ stage_id: string; state: string; input_sha256: string }> {
  return db.prepare("SELECT stage_id, state, input_sha256 FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=?")
    .all(runId, taskId) as Array<{ stage_id: string; state: string; input_sha256: string }>;
}

export function listStaleOpenStages(db: LanePilotDatabase, updatedBefore: number, openAttemptStates: readonly string[]): Array<{ run_id: string; task_id: string; stage_id: string; state: string; updated_at: number; project_id: string }> {
  return db.prepare(`SELECT s.run_id, s.task_id, s.stage_id, s.state, s.updated_at, r.project_id FROM lane_pilot_stage_receipt s JOIN lane_pilot_run r ON r.id=s.run_id
    WHERE s.state IN ('pending','running') AND s.updated_at < ? AND r.state='running'
      AND NOT EXISTS (SELECT 1 FROM lane_pilot_attempt a WHERE a.run_id=s.run_id AND a.task_id=s.task_id AND a.state IN (${openAttemptStates.map(() => "?").join(",")}))
      AND EXISTS (SELECT 1 FROM lane_pilot_attempt a WHERE a.run_id=s.run_id AND a.task_id=s.task_id)`)
    .all(updatedBefore, ...openAttemptStates) as Array<{ run_id: string; task_id: string; stage_id: string; state: string; updated_at: number; project_id: string }>;
}

export function listProjectsWithCriticReceipts(db: LanePilotDatabase, since: number): string[] {
  return (db.prepare(`SELECT DISTINCT r.project_id AS id FROM lane_pilot_stage_receipt s JOIN lane_pilot_run r ON r.id=s.run_id
    WHERE s.updated_at>=? AND s.stage_id IN ('plan-critique','code-critique','specialist-review')`).all(since) as Array<{ id: string }>).map((row) => row.id);
}

export function gateEventFailureCounts(db: LanePilotDatabase, runId: string, taskId: string): Array<{ gate: string; status: string; n: number }> {
  return db.prepare("SELECT gate, status, count(*) AS n FROM lane_pilot_gate_event WHERE run_id=? AND task_id=? AND status IN ('rejected','failed') GROUP BY gate, status")
    .all(runId, taskId) as Array<{ gate: string; status: string; n: number }>;
}

export function failedStageCounts(db: LanePilotDatabase, runId: string, taskId: string): Array<{ stage_id: string; n: number }> {
  return db.prepare("SELECT stage_id, count(*) AS n FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=? AND state IN ('failed','blocked') GROUP BY stage_id")
    .all(runId, taskId) as Array<{ stage_id: string; n: number }>;
}
