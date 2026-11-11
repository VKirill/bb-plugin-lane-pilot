import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActionOrder } from "./action-order";

/**
 * Specialist OS policy loader, tool-tier classifier (`R/D/L/S`, unknown -> `L` [`G-03`]),
 * upper-bound cost estimator (`G-13`), Wilson 95% lower-bound autonomy gate, and RU calendar seasonality check.
 */
export const SP_ACTION_KEYS = [
  "sp.load_memory",
  "sp.run_script",
  "sp.jev_question_triage",
  "sp.dispatch_tasks",
  "sp.commit_memory",
  "sp.breaker_eval",
  "sp.apply_mutation",
  "sp.message_match",
  "sp.charter_set",
  "sp.cf_feedback",
] as const;

export type SpActionKey = (typeof SP_ACTION_KEYS)[number];
export type ToolTier = "R" | "D" | "L" | "S";
export type AutonomyClass = "observe" | "propose" | "bounded_auto";

interface ToolSpec {
  tier: ToolTier;
  max_cost_usd?: number | null;
  unit_cost_usd_per_item?: number;
  max_items?: number;
}

interface TierPolicy {
  default_unknown_tier: ToolTier;
  servers: Record<string, { default: ToolTier; tools: Record<string, ToolSpec> }>;
}

interface SpPolicy {
  autonomy: {
    default_class: AutonomyClass;
    promotion_gates: {
      min_samples: number;
      wilson_lower_bound_min: number;
      cohen_kappa_min: number;
      zero_critical_incidents_days: number;
    };
    high_risk_never_auto: string[];
  };
  budgets: {
    daily_cap_usd_default: number;
    cell_cap_usd_default: number;
    rolling_24h_auto_cap_usd_default: number;
    max_concurrent_active_cells: number;
    refuse_unknown_upper_bound: boolean;
  };
  mutation_guards: {
    approval_nonce_ttl_ms: number;
    single_use_nonce: boolean;
    strategy_guard: {
      max_budget_delta_ratio: number;
      min_hours_between_budget_edits: number;
      max_bid_strategy_changes_per_7d: number;
    };
  };
  questions: {
    max_owner_questions_per_tick: number;
    max_shadow_ext_questions: number;
    p0_impact_weight_min: number;
    default_cooldown_hours: number;
  };
}

interface RuCalendar {
  annual_holidays: Array<{ id: string; start_mm_dd: string; end_mm_dd: string; kind: string; b2b_dip: boolean; ecom_shift: boolean }>;
  retail_surges: Array<{ id: string; start_mm_dd: string; end_mm_dd: string; cpc_inflation_expected: boolean }>;
}

let cachedRoot: string | null = null;
let cachedTiers: TierPolicy | null = null;
let cachedPolicy: SpPolicy | null = null;
let cachedCalendar: RuCalendar | null = null;

export function resolvePluginRoot(): string {
  if (cachedRoot) return cachedRoot;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../../.."),
    resolve(here, "../.."),
    process.cwd(),
  ];
  for (const cand of candidates) {
    if (existsSync(join(cand, "policy", "sp-policy.json")) || existsSync(join(cand, "workflows"))) {
      cachedRoot = cand;
      return cand;
    }
  }
  cachedRoot = resolve(here, "../../..");
  return cachedRoot;
}

export function loadSpPolicy(): SpPolicy {
  if (cachedPolicy) return cachedPolicy;
  const raw = readFileSync(join(resolvePluginRoot(), "policy", "sp-policy.json"), "utf8");
  cachedPolicy = JSON.parse(raw) as SpPolicy;
  return cachedPolicy;
}

export function loadToolTiers(): TierPolicy {
  if (cachedTiers) return cachedTiers;
  const raw = readFileSync(join(resolvePluginRoot(), "policy", "ohmy-tool-tiers.json"), "utf8");
  cachedTiers = JSON.parse(raw) as TierPolicy;
  return cachedTiers;
}

export function loadRuCalendar(): RuCalendar {
  if (cachedCalendar) return cachedCalendar;
  const raw = readFileSync(join(resolvePluginRoot(), "policy", "calendar-ru.json"), "utf8");
  cachedCalendar = JSON.parse(raw) as RuCalendar;
  return cachedCalendar;
}

/** Classifies an MCP tool into `R | D | L | S`; unknown server or unknown tool defaults to `"L"` (`G-03`). */
export function classifyToolTier(server?: string | null, tool?: string | null): ToolTier {
  const tiers = loadToolTiers();
  if (!server) return tiers.default_unknown_tier ?? "L";
  const srv = tiers.servers[server];
  if (!srv) return tiers.default_unknown_tier ?? "L";
  if (!tool) return srv.default ?? "L";
  const entry = srv.tools[tool];
  return entry?.tier ?? srv.default ?? "L";
}

export interface CostEstimate {
  ok: boolean;
  upperBoundUsd: number;
  tier: ToolTier;
  reason?: string;
}

/** Computes upper-bound USD cost for an action order; refuses unbounded / unknown tariffs (`G-13`). */
export function estimateActionOrderCost(order: ActionOrder): CostEstimate {
  if (!order.tariff_known) {
    return { ok: false, upperBoundUsd: 0, tier: "L", reason: "unknown_tariff_upper_bound" };
  }
  if (order.kind === "direct_api") {
    const tiers = loadToolTiers();
    const tier = classifyToolTier(order.server, order.tool);
    if (tier === "S") {
      return { ok: false, upperBoundUsd: 0, tier: "S", reason: "tier_S_sensitive_forbidden" };
    }
    const spec = order.server && order.tool ? tiers.servers[order.server]?.tools[order.tool] : undefined;
    if (typeof order.estimated_cost_usd === "number" && Number.isFinite(order.estimated_cost_usd)) {
      return { ok: true, upperBoundUsd: order.estimated_cost_usd, tier };
    }
    if (spec && typeof spec.max_cost_usd === "number") {
      return { ok: true, upperBoundUsd: spec.max_cost_usd, tier };
    }
    return { ok: false, upperBoundUsd: 0, tier, reason: "unknown_api_cost_upper_bound" };
  }
  if (order.kind === "content_batch") {
    const rawBatch = order.cf_batch ?? {};
    const seoLen = Array.isArray(rawBatch.seo_items) ? rawBatch.seo_items.length : 0;
    const orgLen = Array.isArray(rawBatch.organic_items) ? rawBatch.organic_items.length : 0;
    const count = seoLen + orgLen;
    if (typeof order.estimated_cost_usd === "number" && Number.isFinite(order.estimated_cost_usd)) {
      return { ok: true, upperBoundUsd: order.estimated_cost_usd, tier: "D" };
    }
    if (count > 0 && count <= 500) {
      return { ok: true, upperBoundUsd: Number((0.15 + count * 0.18).toFixed(4)), tier: "D" };
    }
    return { ok: false, upperBoundUsd: 0, tier: "D", reason: "unknown_batch_size_upper_bound" };
  }
  const fallback = typeof order.estimated_cost_usd === "number" ? order.estimated_cost_usd : order.kind === "owner_escalate" ? 0 : 0.25;
  return { ok: true, upperBoundUsd: fallback, tier: order.kind === "owner_escalate" ? "R" : "D" };
}

/** Wilson 95% score interval lower bound (`z = 1.96`). */
export function wilsonLowerBound(successes: number, n: number, z = 1.96): number {
  if (n <= 0 || successes < 0) return 0;
  const k = Math.min(successes, n);
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, Number(((center - spread) / denom).toFixed(4)));
}

export function evaluateAutonomyGate(input: {
  actionClass: string;
  samplesN: number;
  successesK: number;
  cohenKappa: number;
  highRisk?: boolean;
}): { allowedClass: AutonomyClass; wilsonLb: number; reason: string } {
  const policy = loadSpPolicy();
  const gates = policy.autonomy.promotion_gates;
  const lb = wilsonLowerBound(input.successesK, input.samplesN);
  if (input.highRisk || policy.autonomy.high_risk_never_auto.includes(input.actionClass)) {
    return { allowedClass: "propose", wilsonLb: lb, reason: "high_risk_never_auto" };
  }
  if (input.samplesN < gates.min_samples) {
    return { allowedClass: "propose", wilsonLb: lb, reason: `insufficient_samples_${input.samplesN}_lt_${gates.min_samples}` };
  }
  if (lb < gates.wilson_lower_bound_min) {
    return { allowedClass: "propose", wilsonLb: lb, reason: `wilson_lb_${lb}_lt_${gates.wilson_lower_bound_min}` };
  }
  if (input.cohenKappa < gates.cohen_kappa_min) {
    return { allowedClass: "propose", wilsonLb: lb, reason: `kappa_${input.cohenKappa}_lt_${gates.cohen_kappa_min}` };
  }
  return { allowedClass: "bounded_auto", wilsonLb: lb, reason: "gates_satisfied" };
}

export function checkRuSeasonality(isoDate: string): { holidayId: string | null; retailSurgeId: string | null } {
  const mmdd = isoDate.slice(5, 10);
  const cal = loadRuCalendar();
  const hitHoliday = cal.annual_holidays.find((h) => mmdd >= h.start_mm_dd && mmdd <= h.end_mm_dd) ?? null;
  const hitSurge = cal.retail_surges.find((s) => mmdd >= s.start_mm_dd && mmdd <= s.end_mm_dd) ?? null;
  return { holidayId: hitHoliday?.id ?? null, retailSurgeId: hitSurge?.id ?? null };
}
