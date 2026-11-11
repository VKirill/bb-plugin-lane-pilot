import { sha256Hex } from "@lane-pilot/kit";
import { ATTEMPT_STATES, IllegalTransitionError, isLegalMove, OPERATIONAL_MOVES, TRANSITION_TABLE } from "../../contracts/state-machine";
import type { FailureCode } from "../../contracts/failure-class";
import type { LanePilotDatabase } from "../database";

/** One key naming the automaton's rule set (SMA ar_stamp): the states, the transition table and the operational moves, hashed. */
export const TRANSITION_KEY: string = sha256Hex(JSON.stringify({ states: ATTEMPT_STATES, transitions: TRANSITION_TABLE, operational: OPERATIONAL_MOVES }));

/** States an attempt never leaves: its work is merged, or the owner stopped it. */
const FINAL_ATTEMPT_STATES = ["accepted", "canceled"] as const;

const illegalTransitionLogs = new WeakMap<LanePilotDatabase, (message:string) => void>();
/** Where a refused move of this database is reported (the plugin log); until set, the console. */
export function setIllegalTransitionLog(db: LanePilotDatabase, log:(message:string) => void):void { illegalTransitionLogs.set(db, log); }

const attemptListeners = new WeakMap<LanePilotDatabase, Set<(attemptId:string, toState?:string, reason?:string) => void>>();
/** Called after an attempt of this database is created or changes state (live screens re-read); returns the function that stops it. A listener's failure never touches the write. `toState`/`reason` are the move's target and note; absent on creation. */
export function onAttemptChanged(db: LanePilotDatabase, listener:(attemptId:string, toState?:string, reason?:string) => void):() => void {
  let listeners = attemptListeners.get(db);
  if (!listeners) { listeners = new Set(); attemptListeners.set(db, listeners); }
  listeners.add(listener);
  return () => { listeners!.delete(listener); };
}
export function attemptChanged(db:LanePilotDatabase, attemptId:string, toState?:string, reason?:string):void {
  for (const listener of attemptListeners.get(db) ?? []) { try { listener(attemptId, toState, reason); } catch { /* a screen update is never worth a failed write */ } }
}

/** The structured facts of a verification failure; the human reason text keeps its wording. */
export type AttemptFailureFields = { failureCode?: FailureCode; checkName?: string; timeoutSec?: number };

/** The structured failure facts of a validateWriterResult-like record, for a caller that passes them to `transitionAttempt`. */
export function failureFieldsOf(row: { failureCode?: unknown; checkName?: unknown; timeoutSec?: unknown }): AttemptFailureFields {
  const failureCode = typeof row.failureCode === "string" ? row.failureCode as FailureCode : undefined;
  const checkName = typeof row.checkName === "string" ? row.checkName : undefined;
  const timeoutSec = typeof row.timeoutSec === "number" ? row.timeoutSec : undefined;
  return {
    ...(failureCode ? { failureCode } : {}),
    ...(checkName ? { checkName } : {}),
    ...(timeoutSec !== undefined ? { timeoutSec } : {}),
  };
}

/**
 * Moves an attempt to a new state and journals it. An accepted or canceled attempt keeps its state: before,
 * a cancel during verification could be overwritten with «accepted» after the merge (fleet invariants audit,
 * 2026-10-03). Returns false when the move was refused that way. The one declared way out of a settled state is
 * `canceled -> queued` (the PM's replan reusing the attempt, reviveCanceledAttempt).
 *
 * Every other move must be a row of the state machine's table (src/state-machine.ts) or one of its documented operational
 * moves. An illegal one is logged, journaled as refused and thrown as `IllegalTransitionError`: a caller that did it is
 * wrong, and the writer loop's catch ends the attempt as `internal_error` (a Lane Pilot fault, parked and restarted).
 *
 * The structured failure facts come from the caller (the producer that knows them); the migration backfilled the rows
 * written before the fields existed. A caller that does not pass them writes NULL.
 */
export function transitionAttempt(
  db: LanePilotDatabase,
  attemptId: string,
  state: string,
  fields: { threadId?: string; reason?: string; wakeAt?: number | null; cancelCode?: string } & AttemptFailureFields = {},
): boolean {
  const now = Date.now();
  const before = db.prepare("SELECT state FROM lane_pilot_attempt WHERE id=?").get(attemptId) as { state: string } | undefined;
  if (!before) return false;
  const settled = (FINAL_ATTEMPT_STATES as readonly string[]).includes(before.state);
  if (!settled && before.state !== state && !isLegalMove(before.state, state)) {
    db.prepare(`INSERT INTO lane_pilot_attempt_transition(attempt_id,from_state,to_state,reason,refused,at) VALUES(?,?,?,?,1,?)`)
      .run(attemptId, before.state, state, `illegal move: ${fields.reason ?? ""}`.trim(), now);
    const error = new IllegalTransitionError(attemptId, before.state, state);
    (illegalTransitionLogs.get(db) ?? ((message: string) => console.warn(message)))(`Lane Pilot refused ${error.message}${fields.reason ? `: ${fields.reason.slice(0, 200)}` : ""}`);
    throw error;
  }
  // A settled attempt keeps its state unless the move is a declared way out (canceled -> queued, the PM's replan).
  // The state write and its journal row land in one transaction (SMA m_wrappers): a crash between them used to leave a
  // state with no journal. Listeners fire after the commit, so a screen never sees a state that was rolled back.
  const changed = db.transaction(() => {
    const reopen = settled && before.state !== state && isLegalMove(before.state, state) ? 1 : 0;
    // «Not passed at all» keeps the wake; an explicit null clears it (parkAttemptWake(…, null)); a number sets it.
    const wakeGiven = fields.wakeAt !== undefined ? 1 : 0;
    const wrote = db.prepare(`UPDATE lane_pilot_attempt SET state=?, thread_id=COALESCE(?,thread_id), reason=?, failure_code=?, check_name=?, timeout_sec=?, updated_at=?,
      wake_at=CASE WHEN ?<>'queued' THEN NULL WHEN ?=1 THEN ? ELSE wake_at END, cancel_code=COALESCE(cancel_code,?)
      WHERE id=? AND (state NOT IN (${FINAL_ATTEMPT_STATES.map(() => "?").join(",")}) OR state=? OR ?)`)
      .run(state, fields.threadId ?? null, fields.reason ?? null, fields.failureCode ?? null,
        fields.checkName ?? null, fields.timeoutSec ?? null,
        now, state, wakeGiven, fields.wakeAt ?? null, fields.cancelCode ?? null, attemptId, ...FINAL_ATTEMPT_STATES, state, reopen).changes === 1;
    db.prepare(`INSERT INTO lane_pilot_attempt_transition(attempt_id,from_state,to_state,reason,refused,at) VALUES(?,?,?,?,?,?)`)
      .run(attemptId, before.state, state, fields.reason ?? null, wrote ? 0 : 1, now);
    // A cancel of an attempt that is already final is refused as a move, but its code is still recorded (as markCancelCode did after the move).
    if (!wrote && fields.cancelCode) db.prepare("UPDATE lane_pilot_attempt SET cancel_code=COALESCE(cancel_code,?) WHERE id=?").run(fields.cancelCode, attemptId);
    // The world counter (SMA m_wrappers) climbs in the same transaction: a failed write leaves it where it was.
    // Its domain is every framed write, attempts and task rows alike, so a reader sees task and hold changes too.
    db.prepare("UPDATE lane_pilot_attempt SET world_seq=(SELECT MAX(COALESCE((SELECT MAX(world_seq) FROM lane_pilot_attempt),0), COALESCE((SELECT MAX(world_seq) FROM lane_pilot_task),0))+1) WHERE id=?").run(attemptId);
    return wrote;
  })();
  if (changed && before.state !== state) attemptChanged(db, attemptId, state, fields.reason);
  return changed;
}

/**
 * Ends an attempt whose writer could not be started (or found again). The PM's stop can land while the spawn is still
 * being made: `cancel_requested` has only canceled, blocked and accepted to go to, and the owner asked for the stop,
 * so that attempt ends «canceled» whatever failed; any other attempt is «spawn_rejected» and retries.
 */
export function endSpawnFailure(db: LanePilotDatabase, attemptId: string, reason: string, threadId?: string): "canceled" | "spawn_rejected" {
  const stopped = (db.prepare("SELECT state FROM lane_pilot_attempt WHERE id=?").get(attemptId) as { state: string } | undefined)?.state === "cancel_requested";
  const state = stopped ? "canceled" : "spawn_rejected";
  transitionAttempt(db, attemptId, state, { reason: stopped ? `writer stop observed after: ${reason}`.slice(0, 500) : reason, ...(threadId ? { threadId } : {}) });
  return state;
}

/**
 * An attempt whose work ran before it was recorded (a native CLI run: the command has finished when the attempt is
 * written): journals the steps it went through, then its outcome. A blocked outcome needs no steps.
 */
export function recordFinishedAttempt(db: LanePilotDatabase, attemptId: string, status: "accepted" | "blocked" | "running", reason?: string): void {
  if (status !== "blocked") {
    transitionAttempt(db, attemptId, "spawn_requested");
    transitionAttempt(db, attemptId, "running");
  }
  if (status !== "running") transitionAttempt(db, attemptId, status, { reason });
}
