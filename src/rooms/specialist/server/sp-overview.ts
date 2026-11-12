import { listMemoryReceipts } from "@lane-pilot/memory-core";
import type { OwnerItemSweep } from "../../owner-waiting";
import { countActiveProjectArtifacts, listRunIdsForProject, listTaskTransitions, type LanePilotDatabase } from "../../storage";
import { specialistLedgerSummary } from "./sp-store";

export interface SpecialistOverviewPayload {
  charters: Array<{ domain: string; version: number; approvedBy: string | null; updatedAt: number }>;
  breakers: Array<{ domain: string; state: string; failureCount: number; cooldownUntil: number | null }>;
  pendingIntents: number;
  dispatchedCount: number;
  activeLocks: number;
  autonomyClasses: Array<{ domain: string; actionClass: string; autonomyClass: string; wilsonLb: number; samplesN: number }>;
  evalRunsCount: number;
  openQuestionsCount: number;
  artifactsCount: number;
  taskTransitionsCount: number;
  memoryReceiptsCount: number;
  spend24hUsd: number;
  spend30dUsd: number;
}

export function specialistOverview(db: LanePilotDatabase, projectId?: string, nowMs = Date.now()): SpecialistOverviewPayload {
  const projWhere = projectId ? "WHERE project_id = ?" : "";
  const projAnd = projectId ? "AND project_id = ?" : "";
  const projArgs = projectId ? [projectId] : [];

  const charters = (
    db
      .prepare(`SELECT domain, version, approved_by, updated_at FROM lane_pilot_sp_charter ${projWhere} ORDER BY domain ASC`)
      .all(...projArgs) as Array<{ domain: string; version: number; approved_by: string | null; updated_at: number }>
  ).map((r) => ({ domain: r.domain, version: r.version, approvedBy: r.approved_by, updatedAt: r.updated_at }));

  const breakers = (
    db
      .prepare(`SELECT domain, state, failure_count, cooldown_until FROM lane_pilot_sp_breaker ${projWhere} ORDER BY domain ASC`)
      .all(...projArgs) as Array<{ domain: string; state: string; failure_count: number; cooldown_until: number | null }>
  ).map((r) => ({ domain: r.domain, state: r.state, failureCount: r.failure_count, cooldownUntil: r.cooldown_until }));

  const pendingIntents = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM lane_pilot_sp_intent WHERE status IN ('staged','held','queued_conflict') ${projAnd}`)
      .get(...projArgs) as { n: number }
  ).n;

  const dispatchedCount = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM lane_pilot_sp_dispatch WHERE status = 'dispatched' ${projAnd}`)
      .get(...projArgs) as { n: number }
  ).n;

  const activeLocks = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM lane_pilot_sp_lock WHERE released_at IS NULL AND expires_at > ? ${projAnd}`)
      .get(nowMs, ...projArgs) as { n: number }
  ).n;

  const autonomyClasses = (
    db
      .prepare(
        `SELECT domain, action_class, autonomy_class, wilson_lb, samples_n FROM lane_pilot_sp_autonomy ${projWhere} ORDER BY domain ASC, action_class ASC`,
      )
      .all(...projArgs) as Array<{
      domain: string;
      action_class: string;
      autonomy_class: string;
      wilson_lb: number;
      samples_n: number;
    }>
  ).map((r) => ({
    domain: r.domain,
    actionClass: r.action_class,
    autonomyClass: r.autonomy_class,
    wilsonLb: r.wilson_lb,
    samplesN: r.samples_n,
  }));

  const evalRunsCount = (
    db.prepare(`SELECT COUNT(*) AS n FROM lane_pilot_sp_eval_run ${projWhere}`).get(...projArgs) as { n: number }
  ).n;

  const openQuestionsCount = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM lane_pilot_sp_question_state WHERE status = 'open' ${projAnd}`)
      .get(...projArgs) as { n: number }
  ).n;

  const artifactsCount = countActiveProjectArtifacts(db, projectId);

  // Active production reader for `lane_pilot_task_transition` via `listTaskTransitions`:
  let taskTransitionsCount = 0;
  if (projectId) {
    const recentRunId = listRunIdsForProject(db, projectId)[0];
    if (recentRunId) {
      taskTransitionsCount = listTaskTransitions(db, recentRunId).length;
    }
  } else {
    taskTransitionsCount = listTaskTransitions(db, undefined, undefined, 100).length;
  }

  const ledger = specialistLedgerSummary(db, nowMs, projectId);
  const memoryReceiptsCount = listMemoryReceipts(db, projectId, 50).length;

  return {
    charters,
    breakers,
    pendingIntents,
    dispatchedCount,
    activeLocks,
    autonomyClasses,
    evalRunsCount,
    openQuestionsCount,
    artifactsCount,
    taskTransitionsCount,
    memoryReceiptsCount,
    spend24hUsd: ledger.spend24hUsd,
    spend30dUsd: ledger.spend30dUsd,
  };
}

export function specialistSnapshot(db: LanePilotDatabase, projectId?: string, nowMs = Date.now()) {
  const ov = specialistOverview(db, projectId, nowMs);
  return {
    charters: ov.charters.length,
    openBreakers: ov.breakers.filter((b) => b.state === "open").length,
    pendingIntents: ov.pendingIntents,
    dispatchedCount: ov.dispatchedCount,
    activeLocks: ov.activeLocks,
    evalRunsCount: ov.evalRunsCount,
    artifactsCount: ov.artifactsCount,
    taskTransitionsCount: ov.taskTransitionsCount,
    spend24hUsd: ov.spend24hUsd,
    spend30dUsd: ov.spend30dUsd,
  };
}

/** Closes resolved specialist owner items when underlying intent / breaker is no longer pending (`OWNER_ITEM_SWEEPS`). */
export const specialistItemSweep: OwnerItemSweep = (db, item) => {
  if (item.key.startsWith("sp:intent:")) {
    const intentId = item.key.slice("sp:intent:".length);
    const row = db.prepare("SELECT status FROM lane_pilot_sp_intent WHERE intent_id = ?").get(intentId) as
      | { status: string }
      | undefined;
    if (row && (row.status === "dispatched" || row.status === "dropped" || row.status === "failed")) {
      return `janitor:intent_${row.status}`;
    }
  }
  if (item.key.startsWith("sp:breaker:")) {
    const parts = item.key.split(":");
    const proj = parts[2] ?? "";
    const dom = parts.slice(3).join(":");
    if (proj && dom) {
      const row = db
        .prepare("SELECT state FROM lane_pilot_sp_breaker WHERE project_id = ? AND domain = ?")
        .get(proj, dom) as { state: string } | undefined;
      if (row && row.state === "closed") return "janitor:breaker_closed";
    }
  }
  return null;
};
