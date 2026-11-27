import { randomUUID } from "node:crypto";
import type { ToolTier } from "@lane-pilot/contracts";
import type { LanePilotDatabase } from "../../../storage";
import {
  type ActionOrder,
  actionOrderSchema,
  canonicalJson,
  computeIdemKey,
  computeSemanticKey,
  dbOrderKindOf,
} from "../../models/action-order";
import { estimateActionOrderCost } from "../../tool-tiers";
import { evaluateOwnerGate, formatRefusalDropReason } from "./sp-autonomy";
import { type SpOutcomeLogger, writePendingOutcome } from "./sp-outcomes";

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

export function listActiveLocks(
  db: LanePilotDatabase,
  projectId: string,
  domain?: string,
  nowMs = Date.now(),
  limit?: number,
): LockRow[] {
  const hasLimit = typeof limit === "number" && Number.isFinite(limit) && limit > 0;
  const limitSql = hasLimit ? " LIMIT ?" : "";
  const limitArgs = hasLimit ? [Math.floor(limit!)] : [];
  if (domain) {
    return db
      .prepare(
        `SELECT * FROM lane_pilot_sp_lock WHERE project_id = ? AND domain = ? AND released_at IS NULL AND expires_at > ? ORDER BY acquired_at ASC${limitSql}`,
      )
      .all(projectId, domain, nowMs, ...limitArgs) as LockRow[];
  }
  return db
    .prepare(
      `SELECT * FROM lane_pilot_sp_lock WHERE project_id = ? AND released_at IS NULL AND expires_at > ? ORDER BY acquired_at ASC${limitSql}`,
    )
    .all(projectId, nowMs, ...limitArgs) as LockRow[];
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
    modelNeedsOwnerGo?: boolean;
    ownerDecision?: "approve" | "decline";
    ownerRefusalReason?: string | null;
    ownerRefusalText?: string | null;
    deferDirectApiGateToDispatch?: boolean;
    hypothesisId?: string | null;
    log?: SpOutcomeLogger;
    nowMs?: number;
  },
): {
  status: "staged" | "held" | "queued_conflict" | "dropped";
  intentId: string;
  dropReason?: string;
  needsOwnerGo: boolean;
  actionClass: string;
  tier: ToolTier;
} {
  const now = input.nowMs ?? Date.now();
  const idem = computeIdemKey(input.projectId, input.domain, input.order, input.slotScope ?? "");
  const sem = computeSemanticKey(input.domain, input.order);
  const gate = evaluateOwnerGate(db, {
    projectId: input.projectId,
    domain: input.domain,
    order: input.order,
    modelNeedsOwnerGo: input.modelNeedsOwnerGo,
    nowMs: now,
  });

  const existing = db
    .prepare("SELECT intent_id, status FROM lane_pilot_sp_intent WHERE project_id = ? AND idem_key = ?")
    .get(input.projectId, idem) as { intent_id: string; status: string } | undefined;
  if (existing) {
    return {
      status: "dropped",
      intentId: existing.intent_id,
      dropReason: "duplicate_idem_key",
      needsOwnerGo: gate.needsOwnerGo,
      actionClass: gate.actionClass,
      tier: gate.tier,
    };
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
    return {
      status: "dropped",
      intentId: semDup.intent_id,
      dropReason: "duplicate_semantic_key",
      needsOwnerGo: gate.needsOwnerGo,
      actionClass: gate.actionClass,
      tier: gate.tier,
    };
  }

  const cost = estimateActionOrderCost(input.order);
  const intentId = `int_${randomUUID()}`;
  let status: "staged" | "held" | "queued_conflict" | "dropped" = "staged";
  let dropReason: string | undefined;

  if (input.ownerDecision === "decline") {
    status = "dropped";
    dropReason = formatRefusalDropReason(input.ownerRefusalReason, input.ownerRefusalText);
  } else if (!cost.ok) {
    status = "dropped";
    dropReason = cost.reason ?? "cost_estimate_refused";
  } else if (input.order.is_stop_or_kill && input.order.cohort_key) {
    const cohort = checkCohortMaturity(db, input.projectId, input.domain, input.order.cohort_key, now);
    if (!cohort.mature) {
      status = "dropped";
      dropReason = "immature_cohort";
    }
  }

  if (
    status === "staged" &&
    gate.needsOwnerGo &&
    input.ownerDecision !== "approve" &&
    !(input.deferDirectApiGateToDispatch && input.order.kind === "direct_api")
  ) {
    status = "held";
    dropReason = "owner_go_required";
  } else if (status === "staged" && input.forceHold) {
    status = "held";
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

  const storedOrder: Record<string, unknown> = {
    ...input.order,
    requires_owner_go: gate.needsOwnerGo,
    model_requires_owner_go: gate.modelNeedsOwnerGo,
    _tier: gate.tier,
    _action_class: gate.actionClass,
    ...(input.ownerDecision ? { _owner_decision: input.ownerDecision } : {}),
    ...(input.ownerDecision === "decline" && input.ownerRefusalReason ? { _owner_refusal_reason: input.ownerRefusalReason } : {}),
  };

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
    canonicalJson(storedOrder),
    dropReason ?? null,
    now,
    now,
  );
  if (status === "staged" && input.order.forecast) {
    writePendingOutcome(
      db,
      {
        intentId,
        projectId: input.projectId,
        domain: input.domain,
        createdAt: now,
        ...(input.hypothesisId !== undefined ? { hypothesisId: input.hypothesisId } : {}),
      },
      input.order.forecast,
      input.log,
    );
  }
  return {
    status,
    intentId,
    ...(dropReason ? { dropReason } : {}),
    needsOwnerGo: gate.needsOwnerGo,
    actionClass: gate.actionClass,
    tier: gate.tier,
  };
}

/** Resolves a held intent after an owner approve/decline decision. */
export function decideHeldIntent(
  db: LanePilotDatabase,
  input: {
    intentId: string;
    decision: "approve" | "decline";
    reason?: string | null;
    text?: string | null;
    nowMs?: number;
  },
  log?: SpOutcomeLogger,
): { ok: boolean; status?: "staged" | "dropped"; dropReason?: string; reason?: string } {
  const now = input.nowMs ?? Date.now();
  const row = db
    .prepare("SELECT intent_id, project_id, domain, status, order_json, created_at FROM lane_pilot_sp_intent WHERE intent_id = ?")
    .get(input.intentId) as
    | { intent_id: string; project_id: string; domain: string; status: string; order_json: string; created_at: number }
    | undefined;
  if (!row) return { ok: false, reason: "unknown_intent" };
  if (row.status !== "held") return { ok: false, reason: `intent_not_held:${row.status}` };

  let orderObj: Record<string, unknown> = {};
  try {
    orderObj = JSON.parse(row.order_json) as Record<string, unknown>;
  } catch {
    orderObj = {};
  }

  if (input.decision === "decline") {
    const dropReason = formatRefusalDropReason(input.reason, input.text);
    const nextOrder = {
      ...orderObj,
      _owner_decision: "decline",
      ...(input.reason ? { _owner_refusal_reason: input.reason } : {}),
    };
    db.prepare("UPDATE lane_pilot_sp_intent SET status = 'dropped', drop_reason = ?, order_json = ?, updated_at = ? WHERE intent_id = ?").run(
      dropReason,
      canonicalJson(nextOrder),
      now,
      input.intentId,
    );
    return { ok: true, status: "dropped", dropReason };
  }

  const parsed = actionOrderSchema.safeParse(orderObj);
  if (parsed.success) {
    const cost = estimateActionOrderCost(parsed.data);
    if (!cost.ok) {
      const dropReason = cost.reason ?? "cost_estimate_refused";
      db.prepare("UPDATE lane_pilot_sp_intent SET status = 'dropped', drop_reason = ?, updated_at = ? WHERE intent_id = ?").run(
        dropReason,
        now,
        input.intentId,
      );
      return { ok: false, status: "dropped", dropReason, reason: dropReason };
    }
  }

  const nextOrder = { ...orderObj, _owner_decision: "approve" };
  db.prepare("UPDATE lane_pilot_sp_intent SET status = 'staged', drop_reason = NULL, order_json = ?, updated_at = ? WHERE intent_id = ?").run(
    canonicalJson(nextOrder),
    now,
    input.intentId,
  );
  if (parsed.success && parsed.data.forecast) {
    writePendingOutcome(
      db,
      {
        intentId: row.intent_id,
        projectId: row.project_id,
        domain: row.domain,
        createdAt: row.created_at,
      },
      parsed.data.forecast,
      log,
    );
  }
  return { ok: true, status: "staged" };
}
