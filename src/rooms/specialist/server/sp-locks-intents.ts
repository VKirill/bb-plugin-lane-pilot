import { randomUUID } from "node:crypto";
import type { LanePilotDatabase } from "../../storage";
import {
  type ActionOrder,
  canonicalJson,
  computeIdemKey,
  computeSemanticKey,
  dbOrderKindOf,
} from "../action-order";
import { estimateActionOrderCost } from "../tool-tiers";

/**
 * Specialist OS SQLite store (Part 2): entity/URL/SEO-indexation locks (`G-04`, `G-09`),
 * immature cohort masks (`G-08`), and outbox intent staging (`G-01`, `E-04`).
 */
export interface LockRow {
  lock_id: string;
  project_id: string;
  domain: string;
  scope_type: string;
  scope_value: string;
  owner_graph: string;
  owner_run_id: string | null;
  reason_code: string;
  meta_json: string;
  acquired_at: number;
  expires_at: number;
}

export function listActiveLocks(db: LanePilotDatabase, projectId: string, domain?: string, nowMs = Date.now()): LockRow[] {
  if (domain) {
    return db
      .prepare("SELECT * FROM lane_pilot_sp_lock WHERE project_id = ? AND domain = ? AND released_at IS NULL AND expires_at > ? ORDER BY acquired_at ASC")
      .all(projectId, domain, nowMs) as LockRow[];
  }
  return db
    .prepare("SELECT * FROM lane_pilot_sp_lock WHERE project_id = ? AND released_at IS NULL AND expires_at > ? ORDER BY acquired_at ASC")
    .all(projectId, nowMs) as LockRow[];
}

function scopesOverlap(aType: string, aVal: string, bType: string, bVal: string): boolean {
  const na = aVal.trim().toLowerCase().replace(/\/+$/, "");
  const nb = bVal.trim().toLowerCase().replace(/\/+$/, "");
  if (na === nb && (aType === bType || (aType === "seo_indexation" && bType === "url") || (aType === "url" && bType === "seo_indexation"))) {
    return true;
  }
  if (aType === "url_prefix" && (bType === "url" || bType === "url_prefix" || bType === "seo_indexation")) {
    return nb === na || nb.startsWith(`${na}/`);
  }
  if (bType === "url_prefix" && (aType === "url" || aType === "url_prefix" || aType === "seo_indexation")) {
    return na === nb || na.startsWith(`${nb}/`);
  }
  return false;
}

export function checkLockCollisions(
  db: LanePilotDatabase,
  input: { projectId: string; scopeType: string; scopeValue: string; ignoreOwnerRunId?: string; nowMs?: number },
): LockRow[] {
  const active = listActiveLocks(db, input.projectId, undefined, input.nowMs ?? Date.now());
  return active.filter(
    (lock) =>
      (!input.ignoreOwnerRunId || lock.owner_run_id !== input.ignoreOwnerRunId) &&
      scopesOverlap(lock.scope_type, lock.scope_value, input.scopeType, input.scopeValue),
  );
}

export function acquireLock(
  db: LanePilotDatabase,
  input: {
    projectId: string;
    domain: string;
    scopeType: "url" | "url_prefix" | "campaign" | "ad_group" | "landing" | "cluster" | "experiment" | "seo_indexation";
    scopeValue: string;
    ownerGraph: string;
    ownerRunId?: string;
    reasonCode: string;
    ttlMs?: number;
    meta?: Record<string, unknown>;
    nowMs?: number;
  },
): { ok: boolean; lockId?: string; conflicts: LockRow[] } {
  const now = input.nowMs ?? Date.now();
  const minTtl = input.scopeType === "seo_indexation" ? 21 * 86_400_000 : 3_600_000;
  const maxTtl = input.scopeType === "seo_indexation" ? 45 * 86_400_000 : 90 * 86_400_000;
  const rawTtl = input.ttlMs ?? (input.scopeType === "seo_indexation" ? 21 * 86_400_000 : 86_400_000);
  const ttl = Math.max(minTtl, Math.min(maxTtl, rawTtl));

  const tx = db.transaction(() => {
    const conflicts = checkLockCollisions(db, {
      projectId: input.projectId,
      scopeType: input.scopeType,
      scopeValue: input.scopeValue,
      ...(input.ownerRunId ? { ignoreOwnerRunId: input.ownerRunId } : {}),
      nowMs: now,
    });
    if (conflicts.length > 0) return { ok: false, conflicts };
    const lockId = `lock_${randomUUID()}`;
    db.prepare(
      `INSERT INTO lane_pilot_sp_lock
        (lock_id, project_id, domain, scope_type, scope_value, owner_graph, owner_run_id, reason_code, meta_json, acquired_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      lockId,
      input.projectId,
      input.domain,
      input.scopeType,
      input.scopeValue,
      input.ownerGraph,
      input.ownerRunId ?? null,
      input.reasonCode,
      canonicalJson(input.meta ?? {}),
      now,
      now + ttl,
    );
    return { ok: true, lockId, conflicts: [] };
  });
  return tx();
}

export function upsertCohort(
  db: LanePilotDatabase,
  input: {
    projectId: string;
    domain: string;
    cohortKey: string;
    channel: string;
    cohortDate: string;
    maturityWindowDays?: number;
    cdfPay: number;
    spendUsd?: number;
    conversions?: number;
    nowMs?: number;
  },
): void {
  const now = input.nowMs ?? Date.now();
  db.prepare(
    `INSERT INTO lane_pilot_sp_cohort
      (project_id, domain, cohort_key, channel, cohort_date, maturity_window_days, cdf_pay, spend_usd, conversions, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, domain, cohort_key) DO UPDATE SET
      cdf_pay = excluded.cdf_pay,
      maturity_window_days = excluded.maturity_window_days,
      spend_usd = excluded.spend_usd,
      conversions = excluded.conversions,
      updated_at = excluded.updated_at`,
  ).run(
    input.projectId,
    input.domain,
    input.cohortKey,
    input.channel,
    input.cohortDate,
    input.maturityWindowDays ?? 14,
    input.cdfPay,
    input.spendUsd ?? 0,
    input.conversions ?? 0,
    now,
  );
}

export function checkCohortMaturity(
  db: LanePilotDatabase,
  projectId: string,
  domain: string,
  cohortKey: string,
  nowMs = Date.now(),
): { mature: boolean; cdfPay: number; unknownCohort?: boolean; reasonCode?: "immature_cohort" } {
  const row = db
    .prepare(
      "SELECT cdf_pay, cohort_date, maturity_window_days FROM lane_pilot_sp_cohort WHERE project_id = ? AND domain = ? AND cohort_key = ?",
    )
    .get(projectId, domain, cohortKey) as
    | { cdf_pay: number; cohort_date: string; maturity_window_days: number }
    | undefined;
  if (!row) return { mature: false, cdfPay: 0, unknownCohort: true, reasonCode: "immature_cohort" };
  const cdfPay = Number.isFinite(row.cdf_pay) ? row.cdf_pay : 0;
  const dateStr = typeof row.cohort_date === "string" ? row.cohort_date.trim() : "";
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](.*))?$/.exec(dateStr);
  if (!dateMatch) {
    return { mature: false, cdfPay, reasonCode: "immature_cohort" };
  }
  const y = Number(dateMatch[1]);
  const m = Number(dateMatch[2]);
  const d = Number(dateMatch[3]);
  const calCheck = new Date(Date.UTC(y, m - 1, d));
  if (
    calCheck.getUTCFullYear() !== y ||
    calCheck.getUTCMonth() !== m - 1 ||
    calCheck.getUTCDate() !== d
  ) {
    return { mature: false, cdfPay, reasonCode: "immature_cohort" };
  }
  const cohortTs = dateMatch[4] ? Date.parse(dateStr) : calCheck.getTime();
  if (!Number.isFinite(cohortTs)) {
    return { mature: false, cdfPay, reasonCode: "immature_cohort" };
  }
  const ageDays = (nowMs - cohortTs) / 86_400_000;
  if (ageDays < 0) {
    return { mature: false, cdfPay, reasonCode: "immature_cohort" };
  }
  if (row.maturity_window_days > 0 && ageDays < row.maturity_window_days) {
    return { mature: false, cdfPay, reasonCode: "immature_cohort" };
  }
  if (cdfPay < 0.6) {
    return { mature: false, cdfPay, reasonCode: "immature_cohort" };
  }
  return { mature: true, cdfPay };
}

export function stageIntent(
  db: LanePilotDatabase,
  input: {
    projectId: string;
    domain: string;
    sourceGraph: string;
    tickId?: string | null;
    slotScope?: string;
    order: ActionOrder;
    forceHold?: boolean;
    nowMs?: number;
  },
): { status: "staged" | "held" | "queued_conflict" | "dropped"; intentId: string; dropReason?: string } {
  const now = input.nowMs ?? Date.now();
  const idem = computeIdemKey(input.projectId, input.domain, input.order, input.slotScope ?? "");
  const sem = computeSemanticKey(input.domain, input.order);

  const existing = db
    .prepare("SELECT intent_id, status FROM lane_pilot_sp_intent WHERE project_id = ? AND idem_key = ?")
    .get(input.projectId, idem) as { intent_id: string; status: string } | undefined;
  if (existing) {
    return { status: "dropped", intentId: existing.intent_id, dropReason: "duplicate_idem_key" };
  }

  // ASTRA-R3-002: Unfinished or un-reconciled intents always block semantic duplicates regardless of age;
  // completed 'dispatched' intents enforce the 24h cooldown window.
  const semDup = db
    .prepare(
      `SELECT intent_id FROM lane_pilot_sp_intent
       WHERE project_id = ? AND domain = ? AND semantic_key = ?
         AND (
           status IN ('staged','held','queued_conflict')
           OR (status = 'failed' AND drop_reason = 'reconcile_required')
           OR (status = 'dispatched' AND created_at >= ?)
         )`,
    )
    .get(input.projectId, input.domain, sem, now - 86_400_000) as { intent_id: string } | undefined;
  if (semDup) {
    return { status: "dropped", intentId: semDup.intent_id, dropReason: "duplicate_semantic_key" };
  }

  const cost = estimateActionOrderCost(input.order);
  const intentId = `int_${randomUUID()}`;
  let status: "staged" | "held" | "queued_conflict" | "dropped" = input.forceHold ? "held" : "staged";
  let dropReason: string | undefined;

  if (!cost.ok) {
    status = "dropped";
    dropReason = cost.reason ?? "cost_estimate_refused";
  } else if (input.order.is_stop_or_kill && input.order.cohort_key) {
    const cohort = checkCohortMaturity(db, input.projectId, input.domain, input.order.cohort_key);
    if (!cohort.mature) {
      status = "dropped";
      dropReason = "immature_cohort";
    }
  }

  if (status === "staged" && input.order.target_scope) {
    const conflicts = checkLockCollisions(db, {
      projectId: input.projectId,
      scopeType: input.order.target_scope.scope_type,
      scopeValue: input.order.target_scope.scope_value,
      nowMs: now,
    });
    if (conflicts.length > 0) {
      status = "queued_conflict";
      dropReason = `lock_conflict:${conflicts[0]!.lock_id}`;
    }
  }

  db.prepare(
    `INSERT INTO lane_pilot_sp_intent
      (intent_id, project_id, domain, source_graph, tick_id, idem_key, semantic_key, order_kind, reason_code, status, estimated_cost_usd, order_json, drop_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    intentId,
    input.projectId,
    input.domain,
    input.sourceGraph,
    input.tickId ?? null,
    idem,
    sem,
    dbOrderKindOf(input.order.kind),
    input.order.reason_code,
    status,
    cost.upperBoundUsd,
    canonicalJson(input.order),
    dropReason ?? null,
    now,
    now,
  );
  return { status, intentId, ...(dropReason ? { dropReason } : {}) };
}
