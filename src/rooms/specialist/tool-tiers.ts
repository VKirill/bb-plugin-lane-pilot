import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActionOrder } from "./models/action-order";

/**
 * Specialist OS policy loader, tool-tier classifier (`R/D/L/S`, unknown -> `L` [`G-03`]),
 * upper-bound cost estimator (`G-13`), and RU calendar seasonality check.
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
] as const;

export type SpActionKey = (typeof SP_ACTION_KEYS)[number];
export type ToolTier = "R" | "D" | "L" | "S";

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
  budgets: {
    daily_cap_usd_default: number;
    cell_cap_usd_default: number;
    rolling_24h_auto_cap_usd_default: number;
    max_concurrent_active_cells: number;
    refuse_unknown_upper_bound: boolean;
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
    if (typeof order.estimated_cost_usd === "number" && Number.isFinite(order.estimated_cost_usd)) {
      return { ok: true, upperBoundUsd: order.estimated_cost_usd, tier: "D" };
    }
    return { ok: true, upperBoundUsd: 0.25, tier: "D" };
  }
  const zeroCostKind = order.kind === "owner_escalate" || order.kind === "owner_gate" || order.kind === "schedule";
  const fallback = typeof order.estimated_cost_usd === "number" ? order.estimated_cost_usd : zeroCostKind ? 0 : 0.25;
  return { ok: true, upperBoundUsd: fallback, tier: order.kind === "owner_escalate" || order.kind === "owner_gate" ? "R" : "D" };
}

export function checkRuSeasonality(isoDate: string): { holidayId: string | null; retailSurgeId: string | null } {
  const mmdd = isoDate.slice(5, 10);
  const cal = loadRuCalendar();
  const hitHoliday = cal.annual_holidays.find((h) => mmdd >= h.start_mm_dd && mmdd <= h.end_mm_dd) ?? null;
  const hitSurge = cal.retail_surges.find((s) => mmdd >= s.start_mm_dd && mmdd <= s.end_mm_dd) ?? null;
  return { holidayId: hitHoliday?.id ?? null, retailSurgeId: hitSurge?.id ?? null };
}
