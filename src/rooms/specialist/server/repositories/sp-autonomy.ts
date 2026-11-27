import {
  type AutonomyClass,
  isAutonomyClass,
  isConclusiveOutcomeVerdict,
  type OwnerRefusalReason,
  type ToolTier,
} from "@lane-pilot/contracts";
import { wilsonInterval } from "../../../evolve";
import type { LanePilotDatabase } from "../../../storage";
import type { ActionOrder } from "../../models/action-order";
import { estimateActionOrderCost, loadSpPolicy } from "../../tool-tiers";
import type { SpOutcomeLogger } from "./sp-outcomes";
import { getCharter } from "./sp-store";
import { REVOKE_FREEZE_DAYS } from "./sp-autonomy-grants";
import { actionClassOfOrder, cohenKappa, isHighRiskActionClass, parseRefusalDropReason, resolveOrderTier } from "./sp-autonomy-rules";

export * from "./sp-autonomy-rules";
export * from "./sp-autonomy-grants";

const DAY_MS = 86_400_000;

export interface AutonomyRow {
  project_id: string;
  domain: string;
  action_class: string;
  autonomy_class: AutonomyClass;
  samples_n: number;
  successes_k: number;
  wilson_lb: number;
  cohen_kappa: number;
  high_risk: number;
  frozen_until: number | null;
  updated_at: number;
}

export interface PromotionCandidate {
  project_id: string;
  domain: string;
  action_class: string;
  autonomy_class: AutonomyClass;
  samples_n: number;
  successes_k: number;
  wilson_lb: number;
  cohen_kappa: number;
  default_action: "keep propose";
}

export interface RefusalCountSummary {
  total: number;
  byReason: Partial<Record<OwnerRefusalReason, number>>;
}

export interface OwnerGateDecision {
  needsOwnerGo: boolean;
  modelNeedsOwnerGo: boolean;
  actionClass: string;
  tier: ToolTier;
  upperBoundUsd: number;
  autoCellCapUsd: number;
  autonomyClass: AutonomyClass;
  highRisk: boolean;
}

/** Counts owner refusals in `lane_pilot_sp_intent` grouped by action class. */
export function countRefusalsByActionClass(
  db: LanePilotDatabase,
  projectId: string,
  domain: string,
): Record<string, RefusalCountSummary> {
  const rows = db
    .prepare(
      `SELECT order_kind, reason_code, drop_reason
       FROM lane_pilot_sp_intent
       WHERE project_id = ? AND domain = ? AND status = 'dropped' AND drop_reason IS NOT NULL`,
    )
    .all(projectId, domain) as Array<{ order_kind: string; reason_code: string; drop_reason: string }>;

  const counts: Record<string, RefusalCountSummary> = {};
  for (const row of rows) {
    const parsed = parseRefusalDropReason(row.drop_reason);
    if (!parsed) continue;
    const ac = actionClassOfOrder(row.order_kind, row.reason_code);
    const entry = (counts[ac] ??= { total: 0, byReason: {} });
    entry.total += 1;
    entry.byReason[parsed.reason] = (entry.byReason[parsed.reason] ?? 0) + 1;
  }
  return counts;
}

/** Returns the standing autonomy class for `(projectId, domain, actionClass)`, defaulting to policy `default_class`. */
export function autonomyOf(
  db: LanePilotDatabase,
  projectId: string,
  domain: string,
  actionClass: string,
  nowMs = Date.now(),
): AutonomyClass {
  const policyDefault = loadSpPolicy().autonomy?.default_class;
  const fallback: AutonomyClass = isAutonomyClass(policyDefault) ? policyDefault : "propose";
  const row = db
    .prepare(
      `SELECT autonomy_class, high_risk, frozen_until
       FROM lane_pilot_sp_autonomy
       WHERE project_id = ? AND domain = ? AND action_class = ?`,
    )
    .get(projectId, domain, actionClass) as { autonomy_class: string; high_risk: number; frozen_until: number | null } | undefined;
  if (!row || !isAutonomyClass(row.autonomy_class)) return fallback;
  if (row.autonomy_class === "bounded_auto") {
    if (row.high_risk === 1 || isHighRiskActionClass(actionClass)) return "propose";
    if (row.frozen_until !== null && row.frozen_until > nowMs) return "propose";
  }
  return row.autonomy_class;
}

function resolveAutoCellCapUsd(db: LanePilotDatabase, projectId: string, domain: string): number {
  const policy = loadSpPolicy();
  const charter = getCharter(db, projectId, domain);
  return charter?.cell_cap_usd ?? policy.budgets.cell_cap_usd_default;
}

/**
 * Computes the deterministic code-enforced owner gate (`needs_owner_go`) for an order:
 * `modelValue || tier ∈ {L,S} || cost > autoCellCap`, unless `autonomyOf === "bounded_auto"`
 * and the action class is not high-risk and `tier !== "S"`.
 */
export function evaluateOwnerGate(
  db: LanePilotDatabase,
  input: {
    projectId: string;
    domain: string;
    order: ActionOrder;
    modelNeedsOwnerGo?: boolean;
    nowMs?: number;
  },
): OwnerGateDecision {
  const now = input.nowMs ?? Date.now();
  const actionClass = actionClassOfOrder(input.order.kind, input.order.reason_code);
  const cost = estimateActionOrderCost(input.order);
  const tier = resolveOrderTier(input.order);
  const autoCellCapUsd = resolveAutoCellCapUsd(db, input.projectId, input.domain);
  const modelNeedsOwnerGo = Boolean(input.modelNeedsOwnerGo ?? input.order.requires_owner_go);
  const highRisk = isHighRiskActionClass(actionClass, input.order);
  const autonomyClass = autonomyOf(db, input.projectId, input.domain, actionClass, now);

  const rawGate = modelNeedsOwnerGo || tier === "L" || tier === "S" || cost.upperBoundUsd > autoCellCapUsd;
  const allowAuto = autonomyClass === "bounded_auto" && !highRisk && tier !== "S";
  const needsOwnerGo = allowAuto ? false : rawGate;

  return {
    needsOwnerGo,
    modelNeedsOwnerGo,
    actionClass,
    tier,
    upperBoundUsd: cost.upperBoundUsd,
    autoCellCapUsd,
    autonomyClass,
    highRisk,
  };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface IntentOutcomeJoinedRow {
  intent_id: string;
  order_kind: string;
  reason_code: string;
  status: string;
  order_json: string;
  drop_reason: string | null;
  created_at: number;
  updated_at: number;
  verdict: string | null;
  measured_at: number | null;
}

function isCriticalLOutcome(row: IntentOutcomeJoinedRow): boolean {
  if (row.verdict !== "below") return false;
  const orderObj = parseJsonObject(row.order_json);
  const tier = resolveOrderTier({
    kind: (typeof orderObj.kind === "string" ? orderObj.kind : row.order_kind) as ActionOrder["kind"],
    tariff_known: orderObj.tariff_known !== false,
    server: typeof orderObj.server === "string" ? orderObj.server : undefined,
    tool: typeof orderObj.tool === "string" ? orderObj.tool : undefined,
    estimated_cost_usd: typeof orderObj.estimated_cost_usd === "number" ? orderObj.estimated_cost_usd : undefined,
    mutations: Array.isArray(orderObj.mutations) ? (orderObj.mutations as Array<Record<string, unknown>>) : undefined,
    items: Array.isArray(orderObj.items) ? (orderObj.items as Array<Record<string, unknown>>) : undefined,
    _tier: orderObj._tier,
  });
  return tier === "L";
}

function latestCriticalIncidentForClass(
  db: LanePilotDatabase,
  rows: readonly IntentOutcomeJoinedRow[],
  projectId: string,
  domain: string,
  actionClass: string,
  sinceMs: number,
): { at: number; reason: string } | null {
  let latest: { at: number; reason: string } | null = null;
  for (const row of rows) {
    if (actionClassOfOrder(row.order_kind, row.reason_code) !== actionClass) continue;
    if (!isCriticalLOutcome(row)) continue;
    const at = row.measured_at ?? row.updated_at;
    if (at < sinceMs) continue;
    if (!latest || at > latest.at) {
      latest = { at, reason: `below_outcome_tier_L:${row.intent_id}` };
    }
  }

  const breaker = db
    .prepare(
      `SELECT state, trigger_codes_json, opened_at, updated_at
       FROM lane_pilot_sp_breaker
       WHERE project_id = ? AND domain = ? AND breaker_key = 'primary'`,
    )
    .get(projectId, domain) as
    | { state: string; trigger_codes_json: string; opened_at: number | null; updated_at: number }
    | undefined;
  if (breaker && (breaker.state === "open" || (breaker.opened_at !== null && breaker.opened_at >= sinceMs))) {
    const breakerAt = breaker.opened_at ?? breaker.updated_at;
    if (breakerAt >= sinceMs && (!latest || breakerAt > latest.at)) {
      latest = { at: breakerAt, reason: "breaker_trip" };
    }
  }
  return latest;
}

/**
 * Recomputes Wilson lower bound, Cohen's kappa, high-risk flags, and automatic revocations on critical incidents
 * for every action class seen in `(projectId, domain)`. Stored `autonomy_class` is preserved unless auto-revoked.
 */
export function recomputeAutonomy(
  db: LanePilotDatabase,
  input: { projectId: string; domain: string; now?: number },
  log?: SpOutcomeLogger,
): AutonomyRow[] {
  const now = input.now ?? Date.now();
  const policy = loadSpPolicy();
  const defaultClass: AutonomyClass = isAutonomyClass(policy.autonomy?.default_class) ? policy.autonomy!.default_class : "propose";
  const incidentWindowDays = policy.autonomy?.promotion_gates.zero_critical_incidents_days ?? 30;
  const incidentSince = now - incidentWindowDays * DAY_MS;

  const rows = db
    .prepare(
      `SELECT i.intent_id, i.order_kind, i.reason_code, i.status, i.order_json, i.drop_reason, i.created_at, i.updated_at,
              o.verdict, o.measured_at
       FROM lane_pilot_sp_intent i
       LEFT JOIN lane_pilot_sp_intent_outcome o ON o.intent_id = i.intent_id
       WHERE i.project_id = ? AND i.domain = ?`,
    )
    .all(input.projectId, input.domain) as IntentOutcomeJoinedRow[];

  const existingRows = db
    .prepare("SELECT * FROM lane_pilot_sp_autonomy WHERE project_id = ? AND domain = ?")
    .all(input.projectId, input.domain) as AutonomyRow[];
  const existingByClass = new Map(existingRows.map((r) => [r.action_class, r]));

  interface ClassAccum {
    n: number;
    k: number;
    a: number;
    b: number;
    c: number;
    d: number;
    highRisk: boolean;
  }

  const accByClass = new Map<string, ClassAccum>();
  const ensureAcc = (ac: string): ClassAccum => {
    let acc = accByClass.get(ac);
    if (!acc) {
      acc = { n: 0, k: 0, a: 0, b: 0, c: 0, d: 0, highRisk: isHighRiskActionClass(ac) };
      accByClass.set(ac, acc);
    }
    return acc;
  };

  for (const ex of existingRows) {
    ensureAcc(ex.action_class);
  }

  for (const row of rows) {
    const ac = actionClassOfOrder(row.order_kind, row.reason_code);
    const orderObj = parseJsonObject(row.order_json);
    const acc = ensureAcc(ac);
    if (isHighRiskActionClass(ac, { action_class: typeof orderObj.action_class === "string" ? orderObj.action_class : undefined })) {
      acc.highRisk = true;
    }

    const refusal = parseRefusalDropReason(row.drop_reason);
    const ownerDecisionRaw =
      orderObj._owner_decision === "approve" || orderObj._owner_decision === "decline"
        ? orderObj._owner_decision
        : refusal
          ? "decline"
          : undefined;

    const measuredVerdict = isConclusiveOutcomeVerdict(row.verdict) ? row.verdict : null;
    const isDecided = ownerDecisionRaw === "approve" || ownerDecisionRaw === "decline";

    if (isDecided || measuredVerdict !== null) {
      acc.n += 1;
      if (ownerDecisionRaw === "decline" || measuredVerdict === "below") {
        // Declined or unfavourable outcome is never a success.
      } else {
        acc.k += 1;
      }
    }

    if (isDecided) {
      const modelSaidGate =
        typeof orderObj.model_requires_owner_go === "boolean"
          ? orderObj.model_requires_owner_go
          : Boolean(orderObj.requires_owner_go);
      const predAuto = !modelSaidGate;
      const ownerApproved = ownerDecisionRaw === "approve";
      if (predAuto && ownerApproved) acc.a += 1;
      else if (predAuto && !ownerApproved) acc.b += 1;
      else if (!predAuto && ownerApproved) acc.c += 1;
      else acc.d += 1;
    }
  }

  const tx = db.transaction(() => {
    const out: AutonomyRow[] = [];
    for (const [ac, acc] of accByClass.entries()) {
      const existing = existingByClass.get(ac);
      let autonomyClass: AutonomyClass = existing && isAutonomyClass(existing.autonomy_class) ? existing.autonomy_class : defaultClass;
      let frozenUntil: number | null = existing?.frozen_until ?? null;

      if (autonomyClass === "bounded_auto") {
        const lastGrant = db
          .prepare(
            `SELECT granted_at, revoked_at FROM lane_pilot_sp_autonomy_grant
             WHERE project_id = ? AND domain = ? AND action_class = ?
             ORDER BY granted_at DESC LIMIT 1`,
          )
          .get(input.projectId, input.domain, ac) as { granted_at: number; revoked_at: number | null } | undefined;
        const lastRevoked = db
          .prepare(
            `SELECT MAX(revoked_at) AS max_rev FROM lane_pilot_sp_autonomy_grant
             WHERE project_id = ? AND domain = ? AND action_class = ? AND revoked_at IS NOT NULL`,
          )
          .get(input.projectId, input.domain, ac) as { max_rev: number | null } | undefined;
        const checkSince = Math.max(incidentSince, lastRevoked?.max_rev ?? 0);
        const incident = latestCriticalIncidentForClass(db, rows, input.projectId, input.domain, ac, checkSince);
        if (incident && (!lastGrant || lastGrant.revoked_at === null)) {
          autonomyClass = "propose";
          frozenUntil = now + REVOKE_FREEZE_DAYS * DAY_MS;
          db.prepare(
            `UPDATE lane_pilot_sp_autonomy_grant
             SET revoked_at = ?, reason = ?
             WHERE project_id = ? AND domain = ? AND action_class = ? AND revoked_at IS NULL`,
          ).run(now, incident.reason, input.projectId, input.domain, ac);
          log?.warn?.(`sp autonomy revoked class=${ac} reason=${incident.reason}`);
        }
      }

      const wilsonLb = acc.n > 0 ? Number(wilsonInterval(acc.k, acc.n).low.toFixed(6)) : 0;
      const kappa = cohenKappa(acc.a, acc.b, acc.c, acc.d);
      const highRiskInt = acc.highRisk ? 1 : 0;

      db.prepare(
        `INSERT INTO lane_pilot_sp_autonomy
          (project_id, domain, action_class, autonomy_class, samples_n, successes_k, wilson_lb, cohen_kappa, high_risk, frozen_until, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, domain, action_class) DO UPDATE SET
          autonomy_class = excluded.autonomy_class,
          samples_n = excluded.samples_n,
          successes_k = excluded.successes_k,
          wilson_lb = excluded.wilson_lb,
          cohen_kappa = excluded.cohen_kappa,
          high_risk = excluded.high_risk,
          frozen_until = excluded.frozen_until,
          updated_at = excluded.updated_at`,
      ).run(input.projectId, input.domain, ac, autonomyClass, acc.n, acc.k, wilsonLb, kappa, highRiskInt, frozenUntil, now);

      log?.info?.(
        `sp autonomy class=${ac} n=${acc.n} wilson=${wilsonLb.toFixed(4)} kappa=${kappa.toFixed(4)} state=${autonomyClass}`,
      );

      out.push({
        project_id: input.projectId,
        domain: input.domain,
        action_class: ac,
        autonomy_class: autonomyClass,
        samples_n: acc.n,
        successes_k: acc.k,
        wilson_lb: wilsonLb,
        cohen_kappa: kappa,
        high_risk: highRiskInt,
        frozen_until: frozenUntil,
        updated_at: now,
      });
    }
    return out;
  });

  return tx();
}

/**
 * Returns `propose` action classes meeting all policy promotion gates (`min_samples`, `wilson_lower_bound_min`,
 * `cohen_kappa_min`, zero critical incidents within `zero_critical_incidents_days`, `high_risk = 0`).
 */
export function promotionCandidates(
  db: LanePilotDatabase,
  options: { projectId?: string; domain?: string; now?: number } = {},
): PromotionCandidate[] {
  const now = options.now ?? Date.now();
  const gates = loadSpPolicy().autonomy?.promotion_gates ?? {
    min_samples: 20,
    wilson_lower_bound_min: 0.8,
    cohen_kappa_min: 0.6,
    zero_critical_incidents_days: 30,
  };
  const incidentSince = now - gates.zero_critical_incidents_days * DAY_MS;

  const clauses = ["autonomy_class = 'propose'", "high_risk = 0", "(frozen_until IS NULL OR frozen_until <= ?)"];
  const args: unknown[] = [now];
  if (options.projectId) {
    clauses.push("project_id = ?");
    args.push(options.projectId);
  }
  if (options.domain) {
    clauses.push("domain = ?");
    args.push(options.domain);
  }

  const rows = db
    .prepare(
      `SELECT * FROM lane_pilot_sp_autonomy
       WHERE ${clauses.join(" AND ")}
       ORDER BY project_id ASC, domain ASC, action_class ASC`,
    )
    .all(...args) as AutonomyRow[];

  const candidates: PromotionCandidate[] = [];
  for (const row of rows) {
    if (isHighRiskActionClass(row.action_class)) continue;
    if (row.samples_n < gates.min_samples) continue;
    if (row.wilson_lb < gates.wilson_lower_bound_min) continue;
    if (row.cohen_kappa < gates.cohen_kappa_min) continue;

    const intentRows = db
      .prepare(
        `SELECT i.intent_id, i.order_kind, i.reason_code, i.status, i.order_json, i.drop_reason, i.created_at, i.updated_at,
                o.verdict, o.measured_at
         FROM lane_pilot_sp_intent i
         LEFT JOIN lane_pilot_sp_intent_outcome o ON o.intent_id = i.intent_id
         WHERE i.project_id = ? AND i.domain = ?`,
      )
      .all(row.project_id, row.domain) as IntentOutcomeJoinedRow[];
    const incident = latestCriticalIncidentForClass(db, intentRows, row.project_id, row.domain, row.action_class, incidentSince);
    if (incident) continue;

    candidates.push({
      project_id: row.project_id,
      domain: row.domain,
      action_class: row.action_class,
      autonomy_class: row.autonomy_class,
      samples_n: row.samples_n,
      successes_k: row.successes_k,
      wilson_lb: row.wilson_lb,
      cohen_kappa: row.cohen_kappa,
      default_action: "keep propose",
    });
  }
  return candidates;
}

/** Lists all stored autonomy rows for `(projectId, domain)`. */
export function listAutonomyRows(db: LanePilotDatabase, projectId: string, domain: string): AutonomyRow[] {
  return db
    .prepare(
      `SELECT * FROM lane_pilot_sp_autonomy
       WHERE project_id = ? AND domain = ?
       ORDER BY action_class ASC`,
    )
    .all(projectId, domain) as AutonomyRow[];
}
