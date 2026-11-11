import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { sha256Hex } from "@lane-pilot/kit";
import type { LanePilotDatabase } from "../../storage";
import { canonicalJson } from "../action-order";
import { classifyToolTier, loadSpPolicy, type ToolTier } from "../tool-tiers";
import { checkCohortMaturity, checkLockCollisions } from "./sp-locks-intents";

/**
 * Specialist OS live mutation guards (`plugin-db-and-sp-executors-spec.md` §3.2 `sp.apply_mutation`):
 * - HMAC-SHA256 single-use approval nonce (`<= 15m` TTL, bound to `projectId + actionId + payloadSha256`) [`G-02`].
 * - Strategy guard (`<= 15%` budget step per `120h`, max 1 bid-strategy switch per `7d`, `exempt_auto_cutoff` support).
 * - Tool-tier gate (`R/D/L/S`): Tier `S` refused unless explicit charter emergency stop plan; Tier `L` requires owner approval / nonce.
 */
const DEFAULT_HMAC_KEY = "lp-specialist-os-hmac-v1";

function hmacSecret(): string {
  return process.env.LP_SP_HMAC_SECRET || DEFAULT_HMAC_KEY;
}

function computeNonceHmac(nonceId: string, projectId: string, actionId: string, payloadSha256: string, expiresAt: number): string {
  return createHmac("sha256", hmacSecret())
    .update(`${nonceId}:${projectId}:${actionId}:${payloadSha256}:${expiresAt}`)
    .digest("hex");
}

export interface ApprovalNonce {
  nonceId: string;
  token: string;
  payloadSha256: string;
  expiresAt: number;
}

/** Mints a single-use HMAC-SHA256 approval nonce (`TTL <= 15 minutes` enforced [`G-02`]). */
export function mintApprovalNonce(
  db: LanePilotDatabase,
  input: {
    projectId: string;
    actionId: string;
    payload: unknown;
    ttlMs?: number;
    nowMs?: number;
  },
): ApprovalNonce {
  const now = input.nowMs ?? Date.now();
  const maxTtl = loadSpPolicy().mutation_guards.approval_nonce_ttl_ms;
  const ttl = Math.max(1_000, Math.min(maxTtl, input.ttlMs ?? maxTtl));
  const expiresAt = now + ttl;
  const nonceId = `nnc_${randomUUID()}`;
  const payloadSha256 = sha256Hex(canonicalJson(input.payload));
  const hmacHex = computeNonceHmac(nonceId, input.projectId, input.actionId, payloadSha256, expiresAt);

  db.prepare(
    `INSERT INTO lane_pilot_sp_nonce
      (nonce_id, project_id, action_id, payload_sha256, hmac_hex, issued_at, expires_at, consumed_at, consumed_by_run)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(nonceId, input.projectId, input.actionId, payloadSha256, hmacHex, now, expiresAt);

  return {
    nonceId,
    token: `${nonceId}.${hmacHex}`,
    payloadSha256,
    expiresAt,
  };
}

/** Atomically verifies and consumes a single-use approval nonce (`G-02`). Replay or payload mismatch fails immediately. */
export function consumeApprovalNonce(
  db: LanePilotDatabase,
  input: {
    projectId: string;
    actionId: string;
    payload: unknown;
    token: string;
    runId?: string;
    nowMs?: number;
  },
): { ok: boolean; nonceId?: string; reason?: "malformed_token" | "nonce_not_found" | "nonce_expired" | "nonce_already_consumed" | "payload_mismatch" | "hmac_mismatch" } {
  const now = input.nowMs ?? Date.now();
  const dot = input.token.indexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed_token" };
  const nonceId = input.token.slice(0, dot);
  const givenHmac = input.token.slice(dot + 1);
  const payloadSha = sha256Hex(canonicalJson(input.payload));

  const tx = db.transaction(() => {
    const row = db
      .prepare("SELECT * FROM lane_pilot_sp_nonce WHERE nonce_id = ? AND project_id = ?")
      .get(nonceId, input.projectId) as
      | {
          nonce_id: string;
          project_id: string;
          action_id: string;
          payload_sha256: string;
          hmac_hex: string;
          expires_at: number;
          consumed_at: number | null;
        }
      | undefined;
    if (!row || row.action_id !== input.actionId) return { ok: false as const, reason: "nonce_not_found" as const };
    if (row.consumed_at !== null) return { ok: false as const, reason: "nonce_already_consumed" as const };
    if (row.expires_at <= now) return { ok: false as const, reason: "nonce_expired" as const };
    if (row.payload_sha256 !== payloadSha) return { ok: false as const, reason: "payload_mismatch" as const };

    const expectedHmac = computeNonceHmac(row.nonce_id, row.project_id, row.action_id, row.payload_sha256, row.expires_at);
    const a = Buffer.from(givenHmac, "utf8");
    const b = Buffer.from(expectedHmac, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b) || row.hmac_hex !== expectedHmac) {
      return { ok: false as const, reason: "hmac_mismatch" as const };
    }

    db.prepare("UPDATE lane_pilot_sp_nonce SET consumed_at = ?, consumed_by_run = ? WHERE nonce_id = ?").run(
      now,
      input.runId ?? null,
      nonceId,
    );
    return { ok: true as const, nonceId };
  });
  return tx();
}

export interface StrategyGuardResult {
  allowed: boolean;
  deltaRatio: number;
  reasons: string[];
}

/** Enforces `<= 15%` budget step per `120h` and max `1` bid-strategy switch per `7d`. */
export function checkStrategyGuard(
  db: LanePilotDatabase,
  input: {
    projectId: string;
    entityId: string;
    mutationKind: "budget_edit" | "bid_strategy_switch" | string;
    currentValue?: number;
    nextValue?: number;
    maxStep?: number;
    minHoursBetweenEdits?: number;
    exemptAutoCutoff?: boolean;
    nowMs?: number;
  },
): StrategyGuardResult {
  const now = input.nowMs ?? Date.now();
  const policy = loadSpPolicy().mutation_guards.strategy_guard;
  const maxStep = input.maxStep ?? policy.max_budget_delta_ratio;
  const minHours = input.minHoursBetweenEdits ?? policy.min_hours_between_budget_edits;
  const reasons: string[] = [];
  let deltaRatio = 0;

  if (typeof input.currentValue === "number" && input.currentValue > 0 && typeof input.nextValue === "number") {
    deltaRatio = Number((Math.abs(input.nextValue - input.currentValue) / input.currentValue).toFixed(4));
    if (!input.exemptAutoCutoff && deltaRatio > maxStep + 1e-9) {
      reasons.push(`budget_step_${deltaRatio}_exceeds_${maxStep}`);
    }
  }

  if (input.mutationKind === "budget_edit" && !input.exemptAutoCutoff) {
    const windowStart = now - minHours * 3_600_000;
    const recent = db
      .prepare(
        "SELECT applied_at FROM lane_pilot_sp_mutation_log WHERE project_id = ? AND entity_id = ? AND mutation_kind = 'budget_edit' AND status IN ('applied','simulated') AND applied_at > ? ORDER BY applied_at DESC LIMIT 1",
      )
      .get(input.projectId, input.entityId, windowStart) as { applied_at: number } | undefined;
    if (recent) {
      const hoursAgo = Number(((now - recent.applied_at) / 3_600_000).toFixed(1));
      reasons.push(`cooldown_active_${hoursAgo}h_lt_${minHours}h`);
    }
  }

  if (input.mutationKind === "bid_strategy_switch") {
    const switches = (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM lane_pilot_sp_mutation_log WHERE project_id = ? AND entity_id = ? AND mutation_kind = 'bid_strategy_switch' AND status IN ('applied','simulated') AND applied_at > ?",
        )
        .get(input.projectId, input.entityId, now - 7 * 86_400_000) as { c: number }
    ).c;
    if (switches >= policy.max_bid_strategy_changes_per_7d) {
      reasons.push(`bid_strategy_switches_${switches}_ge_${policy.max_bid_strategy_changes_per_7d}_in_7d`);
    }
  }

  return { allowed: reasons.length === 0, deltaRatio, reasons };
}

export interface MutationItem {
  entity_id?: string;
  mutation_kind?: string;
  server?: string;
  tool?: string;
  current_value?: number;
  next_value?: number;
  exempt_auto_cutoff?: boolean;
  cohort_key?: string;
  is_stop?: boolean;
  scope_type?: string;
  scope_value?: string;
}

export function applyMutationsBatch(
  db: LanePilotDatabase,
  input: {
    projectId: string;
    domain: string;
    tier: ToolTier;
    items: MutationItem[];
    nonceToken?: string;
    actionId?: string;
    emergencyAuthorised?: boolean;
    maxStep?: number;
    minHoursBetweenEdits?: number;
    runId?: string;
    nowMs?: number;
  },
): { applied: number; failed: number; mutationIds: string[]; errors: string[] } {
  const now = input.nowMs ?? Date.now();
  const errors: string[] = [];
  const mutationIds: string[] = [];

  if (input.tier === "S" && !input.emergencyAuthorised) {
    return { applied: 0, failed: Math.max(1, input.items.length), mutationIds: [], errors: ["tier_S_forbidden_without_emergency_charter"] };
  }

  let verifiedNonceId: string | null = null;
  if (input.tier === "L") {
    if (!input.nonceToken || !input.actionId) {
      return { applied: 0, failed: Math.max(1, input.items.length), mutationIds: [], errors: ["missing_approval_nonce"] };
    }
    const consumed = consumeApprovalNonce(db, {
      projectId: input.projectId,
      actionId: input.actionId,
      payload: input.items,
      token: input.nonceToken,
      ...(input.runId ? { runId: input.runId } : {}),
      nowMs: now,
    });
    if (!consumed.ok) {
      return { applied: 0, failed: Math.max(1, input.items.length), mutationIds: [], errors: [`nonce_${consumed.reason}`] };
    }
    verifiedNonceId = consumed.nonceId ?? null;
  }

  let applied = 0;
  let failed = 0;

  for (const item of input.items) {
    const entityId = item.entity_id || "default_entity";
    const mKind = item.mutation_kind || "config_update";
    const resolvedTier = item.server || item.tool ? classifyToolTier(item.server, item.tool) : input.tier;

    if (resolvedTier === "S" && !input.emergencyAuthorised) {
      failed++;
      errors.push(`${entityId}:tier_S_tool_refused`);
      continue;
    }

    if (item.is_stop && item.cohort_key) {
      const mat = checkCohortMaturity(db, input.projectId, input.domain, item.cohort_key);
      if (!mat.mature) {
        failed++;
        errors.push(`${entityId}:immature_cohort`);
        continue;
      }
    }

    if (item.scope_type && item.scope_value) {
      const locks = checkLockCollisions(db, {
        projectId: input.projectId,
        scopeType: item.scope_type,
        scopeValue: item.scope_value,
        ...(input.runId ? { ignoreOwnerRunId: input.runId } : {}),
        nowMs: now,
      });
      if (locks.length > 0 && !input.emergencyAuthorised) {
        failed++;
        errors.push(`${entityId}:locked_by_${locks[0]!.lock_id}`);
        continue;
      }
    }

    const sg = checkStrategyGuard(db, {
      projectId: input.projectId,
      entityId,
      mutationKind: mKind,
      ...(typeof item.current_value === "number" ? { currentValue: item.current_value } : {}),
      ...(typeof item.next_value === "number" ? { nextValue: item.next_value } : {}),
      ...(typeof input.maxStep === "number" ? { maxStep: input.maxStep } : {}),
      ...(typeof input.minHoursBetweenEdits === "number" ? { minHoursBetweenEdits: input.minHoursBetweenEdits } : {}),
      ...(item.exempt_auto_cutoff ? { exemptAutoCutoff: true } : {}),
      nowMs: now,
    });
    if (!sg.allowed && !input.emergencyAuthorised) {
      failed++;
      errors.push(`${entityId}:${sg.reasons.join(",")}`);
      db.prepare(
        `INSERT INTO lane_pilot_sp_mutation_log
          (mutation_id, project_id, domain, entity_id, mutation_kind, tier, delta_ratio, nonce_id, status, detail_json, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'blocked', ?, ?)`,
      ).run(`mut_${randomUUID()}`, input.projectId, input.domain, entityId, mKind, resolvedTier, sg.deltaRatio, verifiedNonceId, canonicalJson({ reasons: sg.reasons }), now);
      continue;
    }

    const mutId = `mut_${randomUUID()}`;
    db.prepare(
      `INSERT INTO lane_pilot_sp_mutation_log
        (mutation_id, project_id, domain, entity_id, mutation_kind, tier, delta_ratio, nonce_id, status, detail_json, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?, ?)`,
    ).run(mutId, input.projectId, input.domain, entityId, mKind, resolvedTier, sg.deltaRatio, verifiedNonceId, canonicalJson(item), now);
    mutationIds.push(mutId);
    applied++;
  }

  return { applied, failed, mutationIds, errors };
}
