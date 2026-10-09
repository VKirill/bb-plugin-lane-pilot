import { targetForPercent, type LanePilotSignal } from "@lane-pilot/world-sim";
import { getTask, listOpenAttempts, listStageReceipts, type LanePilotDatabase } from "../../storage";

/**
 * Lane Pilot's own run data turned into world signals. Nothing here talks to the world: `poll` reads the plugin database
 * (attempts, their stage receipts, council sessions) and says what is new since the last call, so a restart, a missed
 * notification or a dirty attempt all go through the same path.
 */

const OPEN = new Set(["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested"]);
/** Attempt states that end an attempt badly; a retry is a new attempt of the same task and rebuilds the site. */
const FAILED = new Set(["blocked", "validation_failed", "spawn_rejected", "provider_error", "timeout", "empty_output"]);
/** How long a writer attempt is expected to take; progress by time runs toward 80% over this. */
export const EXPECTED_ATTEMPT_MS = 20 * 60_000;
/** A council that has not changed for this long is taken as dead (a crash leaves its state open). */
export const COUNCIL_STALE_MS = 45 * 60_000;

type Row = { id: string; runId: string; taskId: string; state: string; createdAt: number; projectId: string };
type Receipt = { stageId: string; state: string; updatedAt: number };
type Seen = { dispatched: boolean; target: number; verification: string; done: boolean };

const ROW_SQL = "SELECT a.id AS id, a.run_id AS runId, a.task_id AS taskId, a.state AS state, a.created_at AS createdAt, r.project_id AS projectId FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id WHERE a.id=?";

/** How far along an attempt is, from its state, its stage receipts and the time since it started: 0 to 0.95. */
export function attemptPercent(row: Pick<Row, "state" | "createdAt">, receipts: readonly Receipt[], now: number, expectedMs = EXPECTED_ATTEMPT_MS): number {
  const stage = (id: string) => receipts.find((r) => r.stageId === id && r.updatedAt >= row.createdAt - 1000)?.state;
  let p = row.state === "running" || row.state === "cancel_requested" ? 0.1 + 0.7 * Math.min(1, Math.max(0, now - row.createdAt) / expectedMs) : 0;
  const verification = stage("verification");
  if (verification === "running") p = Math.max(p, 0.85);
  if (verification === "passed") p = Math.max(p, 0.9);
  const critique = stage("code-critique");
  if (critique === "running" || critique === "passed") p = Math.max(p, 0.92);
  if (stage("acceptance-receipt")) p = Math.max(p, 0.95);
  return p;
}

/** What one attempt's current state adds to what the world has already been told. Updates `seen`. */
export function deriveAttemptSignals(row: Row, receipts: readonly Receipt[], now: number, seen: Seen, title?: string): LanePilotSignal[] {
  const out: LanePilotSignal[] = [];
  if (!seen.dispatched) {
    out.push({ type: "task_dispatched", projectId: row.projectId, taskId: row.taskId, attemptId: row.id, ...(title ? { title } : {}) });
    seen.dispatched = true;
  }
  const target = targetForPercent(attemptPercent(row, receipts, now));
  if (target > seen.target) { out.push({ type: "attempt_progress", attemptId: row.id, percent: attemptPercent(row, receipts, now) }); seen.target = target; }
  const verification = receipts.find((r) => r.stageId === "verification" && r.updatedAt >= row.createdAt - 1000)?.state;
  const phase = verification === "running" ? "started" : verification === "passed" ? "passed" : verification === "failed" ? "failed" : null;
  if (phase && phase !== seen.verification) { out.push({ type: "verification", attemptId: row.id, phase }); seen.verification = phase; }
  if (row.state === "accepted") { out.push({ type: "accepted", attemptId: row.id }); seen.done = true; }
  else if (FAILED.has(row.state)) { out.push({ type: "failed", attemptId: row.id, reason: row.state }); seen.done = true; }
  else if (row.state === "canceled") seen.done = true;
  return out;
}

/** Councils in progress across projects that changed since `since` (the table belongs to @lane-pilot/council). */
function activeCouncils(db: LanePilotDatabase, since: number): Array<{ id: string; projectId: string; seats: number }> {
  const rows = db.prepare("SELECT id, project_id, seats_json FROM lane_pilot_council WHERE state IN ('agenda','discussion','synthesis') AND updated_at>? ORDER BY created_at").all(since) as Array<{ id: string; project_id: string; seats_json: string }>;
  return rows.map((row) => ({ id: row.id, projectId: row.project_id, seats: (JSON.parse(row.seats_json) as unknown[]).length }));
}

export type SignalSource = ReturnType<typeof createSignalSource>;

export function createSignalSource(deps: { db: LanePilotDatabase; now?: () => number }) {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const seen = new Map<string, Seen>();
  const projects = new Set<string>();
  const councils = new Set<string>();

  const titleOf = (taskId: string): string | undefined => {
    const contract = getTask(db, taskId)?.contract as { title?: unknown; objective?: unknown } | undefined;
    const text = typeof contract?.title === "string" ? contract.title : typeof contract?.objective === "string" ? contract.objective : "";
    return text ? text.replace(/\s+/g, " ").slice(0, 48) : undefined;
  };

  function forAttempt(id: string, out: LanePilotSignal[]): void {
    const state = seen.get(id) ?? { dispatched: false, target: -1, verification: "", done: false };
    if (state.done) return;
    const row = db.prepare(ROW_SQL).get(id) as Row | undefined;
    if (!row) { state.done = true; seen.set(id, state); return; }
    if (!projects.has(row.projectId)) { projects.add(row.projectId); out.push({ type: "project_upserted", projectId: row.projectId }); }
    const receipts = listStageReceipts(db, row.runId, row.taskId);
    out.push(...deriveAttemptSignals(row, receipts, now(), state, state.dispatched ? undefined : titleOf(row.taskId)));
    seen.set(id, state);
  }

  return {
    /** Tells the source what the world already has, so a restart does not announce everything again. */
    seed(known: { attempts?: Iterable<string>; projects?: Iterable<string>; councils?: Iterable<string> }): void {
      for (const id of known.attempts ?? []) if (!seen.has(id)) seen.set(id, { dispatched: true, target: -1, verification: "", done: false });
      for (const id of known.projects ?? []) projects.add(id);
      for (const id of known.councils ?? []) councils.add(id);
    },

    /** New signals since the last call: open attempts, the ones named in `dirty`, and councils starting or ending. */
    poll(dirty: Iterable<string> = []): LanePilotSignal[] {
      const out: LanePilotSignal[] = [];
      const ids = new Set<string>(listOpenAttempts(db).map((a) => a.id));
      for (const id of dirty) ids.add(id);
      for (const [id, state] of seen) if (!state.done) ids.add(id);
      for (const id of ids) forAttempt(id, out);
      if (seen.size > 2000) for (const [id, state] of seen) if (state.done && seen.size > 1000) seen.delete(id);

      const active = activeCouncils(db, now() - COUNCIL_STALE_MS);
      const activeIds = new Set(active.map((c) => c.id));
      for (const c of active) if (!councils.has(c.id)) { councils.add(c.id); out.push({ type: "council_started", councilId: c.id, projectId: c.projectId, seats: Math.min(10, Math.max(3, c.seats)) }); }
      for (const id of [...councils]) if (!activeIds.has(id)) { councils.delete(id); out.push({ type: "council_ended", councilId: id }); }
      return out;
    },
  };
}
