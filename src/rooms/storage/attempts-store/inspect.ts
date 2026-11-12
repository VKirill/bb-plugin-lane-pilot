import { parseDirtSnapshots, type DirtSnapshot } from "../../dirt-snapshot";
import { sha256Hex } from "@lane-pilot/kit";
import type { LanePilotDatabase } from "../database";
import { getReasoningTrace } from "./reasoning";


/**
 * One page of a project's state for `bb lane-pilot state`: the newest runs first, their attempts in short rows. The whole history with
 * every column was 147 MB for one project (the dirt snapshots alone 126 MB) against the CLI bridge's 1 MB (audit 2026-10-28); the
 * heavy columns of one attempt come from `state <project> --attempt <id>` (inspectAttempt).
 */
export const STATE_REASON_CHARS = 300;
export function inspectState(db: LanePilotDatabase, projectId: string, page: { limit?: number; before?: number; beforeId?: string } = {}): Record<string,unknown> {
  const limit = Math.max(1, Math.min(page.limit ?? 10, 100));
  const runs = db.prepare(`SELECT id,state,kind,pm_thread_id,created_at,updated_at,closed_at,closed_by,writer_host_id,writer_workspace_path,run_gate,objective
    FROM lane_pilot_run WHERE project_id=? AND (created_at < ? OR (created_at = ? AND id < ?))
    ORDER BY created_at DESC, id DESC LIMIT ?`).all(projectId, page.before ?? Number.MAX_SAFE_INTEGER, page.before ?? Number.MAX_SAFE_INTEGER, page.beforeId ?? "", limit + 1) as Array<{ id: string; created_at: number }>;
  const more = runs.length > limit;
  const shown = runs.slice(0, limit);
  const ids = shown.map((run) => run.id);
  const attempts = ids.length ? db.prepare(`SELECT id,run_id,task_id,attempt_no,state,
      CASE WHEN length(reason) > ${STATE_REASON_CHARS} THEN substr(reason,1,${STATE_REASON_CHARS}) || '…' ELSE reason END AS reason,
      thread_id,holder_thread_id,created_at,updated_at
    FROM lane_pilot_attempt WHERE run_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at`).all(...ids) : [];
  const settings = db.prepare(`SELECT project_id,binding_id,key,version,updated_at
    FROM lane_pilot_project_settings WHERE project_id=? ORDER BY binding_id,key`).all(projectId);
  const totals = db.prepare(`SELECT (SELECT count(*) FROM lane_pilot_run WHERE project_id=?) AS runs,
    (SELECT count(*) FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id WHERE r.project_id=?) AS attempts`).get(projectId, projectId);
  return { projectId, totals, settings, runs: shown, attempts,
    ...(more ? { next: `bb lane-pilot state ${projectId} --before ${shown[shown.length - 1]!.created_at}:${encodeURIComponent(shown[shown.length - 1]!.id)}${page.limit ? ` --limit ${limit}` : ""}` } : {}),
    detail: `bb lane-pilot state ${projectId} --attempt <attempt-id>` };
}

/** One attempt: at most 200 dirt entries and one page of its failure reason, with a command to read the rest. */
export const STATE_REASON_PAGE_CHARS = 16_384;
export function inspectAttempt(db: LanePilotDatabase, projectId: string, attemptId: string, reasonOffset = 0): Record<string,unknown> | null {
  const row = db.prepare(`SELECT a.* FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id WHERE r.project_id=? AND a.id=?`).get(projectId, attemptId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const { dirt_before_json, workspace_decision_json, ...rest } = row;
  const dirt = parseDirtSnapshots(typeof dirt_before_json === "string" ? dirt_before_json : "[]");
  let workspace_decision: unknown = null;
  if (typeof workspace_decision_json === "string") { try { workspace_decision = JSON.parse(workspace_decision_json); } catch { workspace_decision = { invalidStoredDecision: true }; } }
  const reason = typeof rest.reason === "string" ? rest.reason : null;
  const end = reasonOffset + STATE_REASON_PAGE_CHARS;
  return { ...rest, reason: reason?.slice(reasonOffset, end) ?? null,
    reason_offset: reasonOffset, reason_chars: reason?.length ?? 0, reason_truncated: reason !== null && (reasonOffset > 0 || reason.length > end),
    ...(reason && reason.length > end ? { reason_next: `bb lane-pilot state ${projectId} --attempt ${attemptId} --reason-offset ${end}` } : {}),
    workspace_decision, dirt_before: dirt.slice(0, 200), dirt_before_count: dirt.length,
    // The per-attempt dossier (SMA ar_run_dir), read back from the store. It goes to a terminal and into a PM prompt, so it
    // is bounded: the trace is its stamp, shas and lengths (never the texts); receipts and gate events are those written
    // while THIS attempt was the task's newest; each list is the newest DOSSIER_LIST_LIMIT and says when it was cut.
    dossier: attemptDossier(db, rest as { id: string; run_id: string; task_id: string; created_at: number; thread_id?: string | null; holder_thread_id?: string | null; barrier_json?: string | null }),
  };
}

export const DOSSIER_LIST_LIMIT = 50;

function attemptDossier(db: LanePilotDatabase, attempt: { id: string; run_id: string; task_id: string; created_at: number; thread_id?: string | null; holder_thread_id?: string | null; barrier_json?: string | null }): Record<string, unknown> {
  const limit = DOSSIER_LIST_LIMIT;
  const cut: Record<string, { shown: number; total: number }> = {};
  // The attempt's own window: from its start to the start of the task's next attempt (open-ended for the newest).
  const next = db.prepare("SELECT MIN(created_at) AS at FROM lane_pilot_attempt WHERE run_id=? AND task_id=? AND created_at>? AND id<>?").get(attempt.run_id, attempt.task_id, attempt.created_at, attempt.id) as { at: number | null };
  const until = next.at ?? Number.MAX_SAFE_INTEGER;
  const newest = <T>(name: string, count: string, listSql: string, ...args: unknown[]): T[] => {
    const total = (db.prepare(`SELECT COUNT(*) AS n ${count}`).get(...args) as { n: number }).n;
    const rows = (db.prepare(`${listSql} DESC LIMIT ${limit}`).all(...args) as T[]).reverse();
    if (total > rows.length) cut[name] = { shown: rows.length, total };
    return rows;
  };
  const transitions = newest("transitions", "FROM lane_pilot_attempt_transition WHERE attempt_id=?",
    "SELECT from_state, to_state, reason, refused, at FROM lane_pilot_attempt_transition WHERE attempt_id=? ORDER BY at DESC, rowid", attempt.id);
  const stageReceipts = newest("stageReceipts", "FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=? AND updated_at>=? AND updated_at<?",
    `SELECT stage_id AS stageId, state, attempt, provider_id AS providerId, model, thread_id AS threadId, (result_json IS NOT NULL) AS hasResult, reason, updated_at AS updatedAt
      FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=? AND updated_at>=? AND updated_at<? ORDER BY updated_at`, attempt.run_id, attempt.task_id, attempt.created_at, until);
  const gateEvents = newest("gateEvents", "FROM lane_pilot_gate_event WHERE run_id=? AND task_id=? AND occurred_at>=? AND occurred_at<?",
    "SELECT gate, status, attempt, occurred_at FROM lane_pilot_gate_event WHERE run_id=? AND task_id=? AND occurred_at>=? AND occurred_at<? ORDER BY id", attempt.run_id, attempt.task_id, attempt.created_at, until);
  const trace = getReasoningTrace(db, attempt.id);
  const context = trace?.dispatchContext;
  // The verifier's input (SMA ar_run_dir): the task's verification commands, hashed, never the whole contract.
  const verifierCommands = ((): string[] => {
    try {
      const json = (db.prepare("SELECT contract_json FROM lane_pilot_task WHERE id=?").get(attempt.task_id) as { contract_json: string | null } | undefined)?.contract_json;
      const verification = (json ? JSON.parse(json) : null) as { verification?: unknown } | null;
      return (Array.isArray(verification?.verification) ? verification!.verification : [])
        .map((row) => String((row as { command?: unknown })?.command ?? "")).filter(Boolean).slice(0, DOSSIER_LIST_LIMIT);
    } catch { return []; }
  })();
  return {
    stream: trace?.stream ?? null,
    verifierInput: { commands: verifierCommands, sha256: verifierCommands.length ? sha256Hex(JSON.stringify(verifierCommands)) : null },
    threadId: attempt.thread_id ?? null, holderThreadId: attempt.holder_thread_id ?? null,
    transitions, stageReceipts, gateEvents,
    reasoningTrace: trace ? {
      stamp: trace.stamp ?? null, planSha256: trace.planSha256, sourceLength: trace.sourceLength,
      ...(context ? { executionPacketSha256: context.executionPacketSha256, lengths: { executionPacket: context.executionPacket.length, memoryText: context.memoryText.length, rulesText: context.rulesText?.length ?? 0, pmReadContext: context.pmReadContext.length, ...(context.promptChars !== undefined ? { prompt: context.promptChars } : {}) } } : {}),
    } : null,
    verdict: attempt.barrier_json ? (() => { try { return JSON.parse(attempt.barrier_json!) as unknown; } catch { return null; } })() : null,
    ...(Object.keys(cut).length ? { cut, limit } : {}),
  };
}

export function getAttempt(db: LanePilotDatabase, attemptId: string): {
  id:string; run_id:string; task_id:string; thread_id:string|null; holder_thread_id:string|null; state:string; reason:string|null;
  failure_code:string|null; check_name:string|null; timeout_sec:number|null; attempt_no:number; dirt_before:DirtSnapshot[];
  workspace_path:string|null;environment_id:string|null;workspace_decision:unknown|null;harness_version:string|null;created_at:number;
  /** The barrier outcome recorded on the row (sma av_record): gate, status, why, tree, verdict summary. */
  barrier:{gate:string;status:string;reason:string|null;tree:string|null;verdict:{status:string;summary:string}|null;at:number}|null;
}|undefined {
  const row = db.prepare("SELECT id,run_id,task_id,thread_id,holder_thread_id,state,reason,failure_code,check_name,timeout_sec,attempt_no,dirt_before_json,workspace_path,environment_id,workspace_decision_json,harness_version,created_at,barrier_json FROM lane_pilot_attempt WHERE id=?").get(attemptId) as
    {id:string; run_id:string; task_id:string; thread_id:string|null; holder_thread_id:string|null; state:string; reason:string|null; failure_code:string|null; check_name:string|null; timeout_sec:number|null; attempt_no:number; dirt_before_json?:string;workspace_path:string|null;environment_id:string|null;workspace_decision_json:string|null;harness_version:string|null;created_at:number;barrier_json:string|null}|undefined;
  if (!row) return undefined;
  const dirt_before = parseDirtSnapshots(row.dirt_before_json ?? "[]");
  let workspace_decision:unknown|null=null;
  if(row.workspace_decision_json){try{workspace_decision=JSON.parse(row.workspace_decision_json);}catch{workspace_decision={invalidStoredDecision:true};}}
  let barrier:null|{gate:string;status:string;reason:string|null;tree:string|null;verdict:{status:string;summary:string}|null;at:number}=null;
  if(row.barrier_json){try{barrier=JSON.parse(row.barrier_json);}catch{barrier=null;}}
  return { id:row.id, run_id:row.run_id, task_id:row.task_id, thread_id:row.thread_id, holder_thread_id:row.holder_thread_id, state:row.state, reason:row.reason ?? null,
    failure_code:row.failure_code ?? null, check_name:row.check_name ?? null, timeout_sec:row.timeout_sec ?? null, attempt_no:row.attempt_no, dirt_before,
    workspace_path:row.workspace_path,environment_id:row.environment_id,workspace_decision,harness_version:row.harness_version ?? null,created_at:row.created_at,barrier };
}
