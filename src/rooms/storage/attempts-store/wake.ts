import type { LanePilotDatabase } from "../database";
import { transitionAttempt } from "./transition";

/**
 * Parks a queued attempt until `wakeAt` while every writer provider is held (H2): the attempt stays `queued`, the
 * wait is journaled as a queued→queued note (an operational move), and the board reads its reason + wake_at.
 */
export function parkAttemptWake(db: LanePilotDatabase, attemptId: string, reason: string, wakeAt: number | null): void {
  // The wake lands in the transition's transaction (SMA m_wrappers): a park is one atomic write, not a state plus a note.
  transitionAttempt(db, attemptId, "queued", { reason, wakeAt });
}

/** Consecutive `queued` parks of an attempt whose journal reason starts with `reasonPrefix`, counted back until a different row. */
export function trailingQueuedParks(db: LanePilotDatabase, attemptId: string, reasonPrefix: string): number {
  const rows = db.prepare("SELECT to_state, reason FROM lane_pilot_attempt_transition WHERE attempt_id=? AND refused=0 ORDER BY at DESC, rowid DESC LIMIT 100")
    .all(attemptId) as Array<{ to_state: string; reason: string | null }>;
  let count = 0;
  for (const row of rows) {
    if (row.to_state !== "queued" || !(row.reason ?? "").startsWith(reasonPrefix)) break;
    count += 1;
  }
  return count;
}

/** Journals that a pre-spawn store read succeeded after parks, so a later `store_read:` streak counts only what followed it. */
export function noteCleanAdmission(db: LanePilotDatabase, attemptId: string): void {
  const state = (db.prepare("SELECT state FROM lane_pilot_attempt WHERE id=?").get(attemptId) as { state: string } | undefined)?.state ?? "queued";
  db.prepare(`INSERT INTO lane_pilot_attempt_transition(attempt_id,from_state,to_state,reason,refused,at) VALUES(?,?,?,?,0,?)`)
    .run(attemptId, state, state, "admission: store reads clean", Date.now());
}

/** How many times the attempt's journal blocked it under a reason prefix — the next such block's sequence number. */
export function blockedReasonCount(db: LanePilotDatabase, attemptId: string, reasonPrefix: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_attempt_transition WHERE attempt_id=? AND to_state='blocked' AND refused=0 AND substr(reason,1,?)=?")
    .get(attemptId, reasonPrefix.length, reasonPrefix) as { n: number }).n;
}

/** Queued attempts whose writer hold ended (or should be re-checked): the minute waker picks them up. */
export function listDueWakes(db: LanePilotDatabase, now: number): Array<{ id: string; run_id: string; task_id: string; reason: string | null }> {
  return db.prepare("SELECT id,run_id,task_id,reason FROM lane_pilot_attempt WHERE state='queued' AND wake_at IS NOT NULL AND wake_at<=? ORDER BY wake_at")
    .all(now) as Array<{ id: string; run_id: string; task_id: string; reason: string | null }>;
}

/** Takes the wake of a queued attempt: clears wake_at once, so two ticks cannot spawn the same attempt twice. */
export function claimAttemptWake(db: LanePilotDatabase, attemptId: string): boolean {
  return db.prepare("UPDATE lane_pilot_attempt SET wake_at=NULL WHERE id=? AND state='queued' AND wake_at IS NOT NULL").run(attemptId).changes === 1;
}

/** The wait is over once the attempt leaves `queued`; a spawn that begins clears any wake still set. */
export function clearAttemptWake(db: LanePilotDatabase, attemptId: string): void {
  db.prepare("UPDATE lane_pilot_attempt SET wake_at=NULL WHERE id=?").run(attemptId);
}
