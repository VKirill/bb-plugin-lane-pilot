import type Database from "better-sqlite3";

import type { RunRow } from "./journal";
import type { WorkflowEngine } from "./engine";

export const RUN_OBSERVATION_KIND = "repo_guard";
export type RunObservationPhase = "before" | "afterExecution";

/** The execution revision: latest append-only step/rerun journal seq. Guard, audit and status rows never move it. */
export function executionRevision(db: Database.Database, runId: string): number {
  return (db.prepare("SELECT COALESCE(MAX(seq),0) AS r FROM lane_pilot_wf_event WHERE run_id=? AND kind IN ('step','rerun')").get(runId) as { r: number }).r;
}

function guardRow(db: Database.Database, runId: string, phase: RunObservationPhase) {
  return db.prepare("SELECT seq, at, detail FROM lane_pilot_wf_event WHERE run_id=? AND kind=? AND to_state=? ORDER BY seq DESC LIMIT 1")
    .get(runId, RUN_OBSERVATION_KIND, phase) as { seq: number; at: number; detail: string | null } | undefined;
}

function guardRevision(db: Database.Database, runId: string, phase: RunObservationPhase): number | null {
  const detail = guardRow(db, runId, phase)?.detail;
  if (!detail) return null;
  try {
    const parsed: unknown = JSON.parse(detail);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as Record<string, unknown>).revision === "number"
      ? (parsed as Record<string, unknown>).revision as number : null;
  } catch { return null; }
}

export function latestRepoGuardSeq(db: Database.Database, runId: string, phase: RunObservationPhase): number | null {
  return guardRow(db, runId, phase)?.seq ?? null;
}

/**
 * One awaited observation point inside the drive loop, root runs only. `before` is journaled once — a real snapshot on the
 * initial drive, an explicit unavailable row on any later drive that finds none. `afterExecution` is journaled before the
 * goal audit of every execution and reused while the revision stands, so a re-drive of the same execution keeps its receipt.
 * Observer failures are explicit null/reason rows.
 */
export async function observeRunPhase(engine: WorkflowEngine, run: RunRow, phase: RunObservationPhase, initialDrive: boolean): Promise<void> {
  if (run.parent_run_id || !engine.options.observeRun) return;
  const j = engine.journal, db = j.db;
  if (phase === "before" && latestRepoGuardSeq(db, run.id, "before") !== null) return;
  const revision = executionRevision(db, run.id);
  if (phase === "afterExecution" && guardRevision(db, run.id, "afterExecution") === revision) return;
  // Engine-owned identity is written after the payload so a callback cannot overwrite revision/at/phase truth.
  const emit = (payload: Record<string, unknown>) => j.event(run.id, null, RUN_OBSERVATION_KIND, null, phase, {
    ...payload, revision, at: engine.now(), initialDrive: phase === "before" ? initialDrive : false,
  });
  if (phase === "before" && !initialDrive) {
    emit({ snapshot: null, reason: "unavailable: not the initial drive" });
    return;
  }
  try {
    const result = await engine.options.observeRun({ run, phase });
    const given = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : {};
    emit({ ...given, snapshot: given.snapshot ?? null, reason: given.reason ?? null });
  } catch (cause) {
    emit({ snapshot: null, reason: `observer_error: ${cause instanceof Error ? cause.message : String(cause)}` });
  }
}

/** The run's observation receipts for the collector: latest `before`, and the `afterExecution` of the CURRENT revision only. */
export function readRootObservations(db: Database.Database, runId: string): {
  revision: number;
  before: { seq: number; at: number; detail: Record<string, unknown> } | null;
  after: { seq: number; at: number; detail: Record<string, unknown> } | null;
} {
  const revision = executionRevision(db, runId);
  const parse = (row: { seq: number; at: number; detail: string | null } | undefined) => {
    if (!row) return null;
    let detail: Record<string, unknown> = {};
    try {
      const parsed: unknown = row.detail ? JSON.parse(row.detail) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) detail = parsed as Record<string, unknown>;
    } catch { /* malformed detail stays an empty object */ }
    return { seq: row.seq, at: row.at, detail };
  };
  const after = parse(guardRow(db, runId, "afterExecution"));
  return { revision, before: parse(guardRow(db, runId, "before")), after: after && after.detail.revision === revision ? after : null };
}
