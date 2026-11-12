import type { DirtSnapshot } from "../../dirt-snapshot";
import { maskCredentials, sha256Hex } from "@lane-pilot/kit";
import type { LanePilotDatabase } from "../database";

export type ReasoningTrace = {
  /** Which machine wrote this trace (SMA ar_stamp): state-machine revision plus the harness version. */
  stamp?:{stateMachineVersion:number;harnessVersion:string;
    /** The automaton's rule-set key and the run policy's sha; absent in traces written before the stamp grew them. */
    transitionKey?:string;policySha256?:string|null};
  /** The run's stream text (SMA ar_run_dir): sha, full length and a bounded excerpt; absent in traces written before it was kept. */
  stream?:{sha256:string;chars:number;excerpt:string};
  planSha256:string;
  sourceLength:number;
  requestedReasoningLevel:string;
  effectiveReasoningLevel:string;
  retryEffort?:{enabled:boolean;retryIndex:number;before:string;after:string;changed:boolean};
  fallbackReason:string|null;
  providerId:string;
  model:string;
  serviceTier:"default"|"fast"|null;
  requestedServiceTier:"default"|"fast";
  runId:string;
  attemptId:string;
  threadId:string|null;
  dispatchContext?:{
    memoryText:string;
    /** Ids of the memory notes mixed into this brief; an accepted attempt credits each (`accepted_count`). Absent before K8. */
    memoryPicked?:string[];
    /** Owner-confirmed project rules; absent in traces written before 0.1.37. */
    rulesText?:string;
    /** Which accepted rules System One picked for this task (ids), out of how many. */
    rulesPicked?:{total:number;picked:string[]};
    executionPacket:string;
    executionPacketSha256:string;
    pmReadContext:string;
    agent:string;
    helperMode:string;
    helperRequired:boolean;
    /** Characters of the brief the writer got; absent before 0.1.90. */
    promptChars?:number;
    /** The writer's permission list as recorded at dispatch (SMA m_tl_terminal_parity); absent in traces written before it was kept. */
    permissions?:string[];
  };
  selectionSource?:{
    providerId:string;
    model:string;
    reasoningLevel:string;
    serviceTier:"default"|"fast"|null;
    reasoningLevelSource:"explicit"|"client-preference";
  };
};

export function saveReasoningTrace(db: LanePilotDatabase, trace: ReasoningTrace): void {
  db.prepare(`INSERT INTO lane_pilot_attempt_reasoning(attempt_id,trace_json) VALUES(?,?)
    ON CONFLICT(attempt_id) DO UPDATE SET trace_json=excluded.trace_json`).run(trace.attemptId, JSON.stringify(trace));
}

export const ATTEMPT_STREAM_EXCERPT_CHARS = 4000;
/**
 * The run's stream text on the trace (SMA ar_run_dir): the whole text is hashed, its length kept, but only an excerpt
 * is stored — the dossier stays bounded whatever the writer said.
 */
export function noteAttemptStream(db: LanePilotDatabase, attemptId: string, text: string): void {
  const trace = getReasoningTrace(db, attemptId);
  if (!trace) return;
  // The sha is over the whole text as it came; the stored excerpt is masked first (credential shapes plus every secret this
  // server handed out — maskCredentials includes redactKnown), then cut, so a token on the cut line cannot survive half-masked.
  const excerpt = maskCredentials(text).text.slice(0, ATTEMPT_STREAM_EXCERPT_CHARS);
  saveReasoningTrace(db, { ...trace, stream: { sha256: sha256Hex(text), chars: text.length, excerpt } });
}

export function setReasoningThread(db: LanePilotDatabase, attemptId:string, threadId:string): void {
  const trace = getReasoningTrace(db, attemptId);
  if (trace) saveReasoningTrace(db, { ...trace, threadId });
}

export function getReasoningTrace(db: LanePilotDatabase, attemptId: string): ReasoningTrace|null {
  const row = db.prepare("SELECT trace_json FROM lane_pilot_attempt_reasoning WHERE attempt_id=?").get(attemptId) as {trace_json:string}|undefined;
  if (!row) return null;
  try { return JSON.parse(row.trace_json) as ReasoningTrace; } catch { return null; }
}

export function setAttemptDirtBefore(db: LanePilotDatabase, attemptId: string, files: DirtSnapshot[] | string[]): void {
  db.prepare("UPDATE lane_pilot_attempt SET dirt_before_json=?, updated_at=? WHERE id=?")
    .run(JSON.stringify(files), Date.now(), attemptId);
}
