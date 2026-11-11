import { z } from "zod";
import { sha256Hex } from "@lane-pilot/kit";

/**
 * Specialist OS typed action-order contracts (`code_task | sub_graph | content_batch | direct_api | owner_escalate`),
 * deterministic reason codes, interval forecasts, and canonical SHA-256 idempotency + semantic keys.
 */
export const REASON_CODES = [
  "charter_missing",
  "tracking_outage",
  "tracking_recheck",
  "anomaly_drop",
  "anomaly_cpc_spike",
  "seasonality_suppressed",
  "immature_cohort",
  "seo_indexation_lock",
  "cannibalization_merge",
  "bofu_canary_expand",
  "bofu_indexation_frozen",
  "ai_visibility_gap",
  "agent_readiness_blocker",
  "message_match_fail",
  "epk_combinatorics_fix",
  "seo_ppc_negative_sync",
  "tg_moderation_fix",
  "tg_pool_rebalance",
  "experiment_launch",
  "experiment_scale",
  "experiment_kill",
  "cro_friction_fix",
  "organic_pack_stage",
  "curriculum_promote",
  "eval_autonomy_update",
  "breaker_emergency_stop",
  "owner_approval_required",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export const intervalForecastSchema = z
  .object({
    metric: z.string().min(1),
    horizon_days: z.number().int().min(1).max(365).default(14),
    lo80: z.number().finite(),
    point: z.number().finite(),
    hi80: z.number().finite(),
    unit: z.string().min(1).default("ratio"),
  })
  .refine((val) => val.lo80 <= val.point && val.point <= val.hi80, {
    message: "interval forecast must satisfy lo80 <= point <= hi80",
  });

export type IntervalForecast = z.infer<typeof intervalForecastSchema>;

export const actionOrderKindSchema = z.enum([
  "code_task",
  "sub_graph",
  "content_batch",
  "direct_api",
  "owner_escalate",
]);

export type ActionOrderKind = z.infer<typeof actionOrderKindSchema>;

export const actionOrderSchema = z.object({
  kind: actionOrderKindSchema,
  title: z.string().min(3).max(240),
  domain: z.enum(["seo", "marketing", "specialist_os"]).default("marketing"),
  reason_code: z.string().min(2).max(80),
  action_class: z.string().min(2).max(80).default("general"),
  target_scope: z
    .object({
      scope_type: z
        .enum([
          "url",
          "url_prefix",
          "campaign",
          "ad_group",
          "landing",
          "cluster",
          "experiment",
          "seo_indexation",
        ])
        .default("url"),
      scope_value: z.string().min(1),
    })
    .optional(),
  cohort_key: z.string().min(1).optional(),
  is_stop_or_kill: z.boolean().default(false),
  requires_owner_go: z.boolean().default(false),
  estimated_cost_usd: z.number().min(0).optional(),
  tariff_known: z.boolean().default(true),
  server: z.string().optional(),
  tool: z.string().optional(),
  workflow_id: z.string().optional(),
  workflow_inputs: z.record(z.string(), z.unknown()).optional(),
  owns_paths: z.array(z.string()).optional(),
  acceptance: z.array(z.string()).optional(),
  cf_batch: z.record(z.string(), z.unknown()).optional(),
  api_payload: z.record(z.string(), z.unknown()).optional(),
  forecast: intervalForecastSchema.optional(),
});

export type ActionOrder = z.infer<typeof actionOrderSchema>;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Exact idempotency hash (`G-01`): prevents duplicate staging/replay of the identical order in a slot/scope. */
export function computeIdemKey(projectId: string, domain: string, order: ActionOrder, slotScope = ""): string {
  return sha256Hex(
    canonicalJson({
      projectId,
      domain,
      slotScope,
      kind: order.kind,
      reason_code: order.reason_code,
      target_scope: order.target_scope ?? null,
      workflow_id: order.workflow_id ?? null,
      server: order.server ?? null,
      tool: order.tool ?? null,
      owns_paths: order.owns_paths ? [...order.owns_paths].sort() : null,
      api_payload: order.api_payload ?? null,
    }),
  );
}

/** Semantic deduplication hash (`E-04`): catches paraphrased duplicate orders targeting the same scope & mechanism. */
export function computeSemanticKey(domain: string, order: ActionOrder): string {
  const normScope = (order.target_scope?.scope_value ?? order.workflow_id ?? order.title)
    .trim()
    .toLowerCase()
    .replace(/\/+$/, "");
  return sha256Hex(
    canonicalJson({
      domain,
      kind: order.kind,
      reason_code: order.reason_code.trim().toLowerCase(),
      scope_type: order.target_scope?.scope_type ?? "none",
      scope_value: normScope,
    }),
  );
}

export function normalizeOrdersInput(raw: unknown, fallbackDomain: "seo" | "marketing" | "specialist_os"): ActionOrder[] {
  const items: unknown[] = [];
  const pushOne = (val: unknown) => {
    if (!val) return;
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (!trimmed) return;
      try {
        pushOne(JSON.parse(trimmed));
      } catch {
        // Ignore unparseable string placeholders
      }
      return;
    }
    if (Array.isArray(val)) {
      for (const el of val) pushOne(el);
      return;
    }
    if (typeof val === "object") items.push(val);
  };
  pushOne(raw);

  const valid: ActionOrder[] = [];
  for (const candidate of items) {
    const rec = candidate as Record<string, unknown>;
    const hydrated = {
      ...rec,
      domain: rec.domain === "seo" || rec.domain === "marketing" || rec.domain === "specialist_os" ? rec.domain : fallbackDomain,
      kind: rec.kind ?? (rec.workflow_id ? "sub_graph" : rec.owns_paths ? "code_task" : "owner_escalate"),
      title: typeof rec.title === "string" && rec.title.trim().length >= 3 ? rec.title.trim() : String(rec.reason_code ?? "Specialist action order"),
      reason_code: typeof rec.reason_code === "string" && rec.reason_code.trim() ? rec.reason_code.trim() : "owner_approval_required",
    };
    const parsed = actionOrderSchema.safeParse(hydrated);
    if (parsed.success) valid.push(parsed.data);
  }
  return valid;
}
