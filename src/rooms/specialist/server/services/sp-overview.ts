import { listMemoryReceipts } from "@lane-pilot/memory-core";
import type { OwnerItemSweep } from "../../../owner-waiting";
import { countActiveProjectArtifacts, listRunIdsForProject, listTaskTransitions, type LanePilotDatabase } from "../../../storage";
import { specialistLedgerSummary } from "../repositories/sp-store";

export interface SpecialistCharterOverview {
  projectId: string;
  domain: string;
  version: number;
  approvedBy: string | null;
  updatedAt: number;
  metric: string | null;
  current: number | null;
  target: number | null;
  due: string | null;
}

export interface SpecialistOverviewPayload {
  charters: SpecialistCharterOverview[];
  breakers: Array<{ domain: string; state: string; failureCount: number; cooldownUntil: number | null }>;
  pendingIntents: number;
  dispatchedCount: number;
  activeLocks: number;
  openQuestionsCount: number;
  artifactsCount: number;
  taskTransitionsCount: number;
  memoryReceiptsCount: number;
  spend24hUsd: number;
  spend30dUsd: number;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseCharterGoal(
  db: LanePilotDatabase,
  projectId: string,
  domain: string,
  charterJson: string,
): { metric: string | null; current: number | null; target: number | null; due: string | null } {
  let obj: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(charterJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
  } catch { /* malformed charter json yields null goal fields */ }
  const ns =
    obj.north_star && typeof obj.north_star === "object" && !Array.isArray(obj.north_star)
      ? (obj.north_star as Record<string, unknown>)
      : obj.northStar && typeof obj.northStar === "object" && !Array.isArray(obj.northStar)
        ? (obj.northStar as Record<string, unknown>)
        : null;
  const metric =
    asText(obj.metric) ??
    asText(ns?.metric_id) ??
    asText(ns?.metricId) ??
    asText(ns?.metric) ??
    asText(obj.goal);
  const target = asNum(obj.target) ?? asNum(ns?.target);
  const due = asText(obj.due) ?? asText(ns?.due) ?? asText(obj.deadline) ?? asText(ns?.deadline);
  let current = asNum(obj.current) ?? asNum(ns?.current) ?? asNum(ns?.value);
  if (current === null && metric) {
    const row = db
      .prepare(
        `SELECT measured FROM lane_pilot_sp_intent_outcome
         WHERE project_id = ? AND domain = ? AND metric = ? AND measured IS NOT NULL
         ORDER BY COALESCE(measured_at, check_at) DESC LIMIT 1`,
      )
      .get(projectId, domain, metric) as { measured: number | null } | undefined;
    current = asNum(row?.measured);
  }
  return { metric, current, target, due };
}

export function specialistOverview(db: LanePilotDatabase, projectId?: string, nowMs = Date.now()): SpecialistOverviewPayload {
  const projWhere = projectId ? "WHERE project_id = ?" : "";
  const projAnd = projectId ? "AND project_id = ?" : "";
  const projArgs = projectId ? [projectId] : [];

  const charters = (
    db
      .prepare(`SELECT project_id, domain, version, charter_json, approved_by, updated_at FROM lane_pilot_sp_charter ${projWhere} ORDER BY project_id ASC, domain ASC`)
      .all(...projArgs) as Array<{ project_id: string; domain: string; version: number; charter_json: string; approved_by: string | null; updated_at: number }>
  ).map((r) => ({
    projectId: r.project_id,
    domain: r.domain,
    version: r.version,
    approvedBy: r.approved_by,
    updatedAt: r.updated_at,
    ...parseCharterGoal(db, r.project_id, r.domain, r.charter_json),
  }));

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
