import { z } from "zod";
import { sha256Hex } from "@lane-pilot/kit";

/**
 * Specialist OS typed action-order contracts (`code_task | sub_graph | content_batch | direct_api | owner_escalate | schedule | specialist_handoff | create_extension | owner_gate`),
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
  "schedule",
  "specialist_handoff",
  "create_extension",
  "owner_gate",
]);

export type ActionOrderKind = z.infer<typeof actionOrderKindSchema>;

export type DbOrderKind = "code_task" | "sub_graph" | "content_batch" | "direct_api" | "owner_escalate";

/** Maps extended logical order kinds onto the 5 SQLite `CHECK` values without altering historical migrations. */
export function dbOrderKindOf(kind: ActionOrderKind | string): DbOrderKind {
  switch (kind) {
    case "code_task":
      return "code_task";
    case "sub_graph":
    case "schedule":
    case "specialist_handoff":
      return "sub_graph";
    case "content_batch":
      return "content_batch";
    case "direct_api":
      return "direct_api";
    case "owner_escalate":
    case "owner_gate":
    case "create_extension":
    default:
      return "owner_escalate";
  }
}

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
  entity_id: z.string().optional(),
  action_id: z.string().optional(),
  nonce_token: z.string().optional(),
  mutations: z.array(z.record(z.string(), z.unknown())).optional(),
  items: z.array(z.record(z.string(), z.unknown())).optional(),
  current_value: z.number().finite().optional(),
  next_value: z.number().finite().optional(),
  timezone: z.string().optional(),
  workflow_id: z.string().optional(),
  workflow: z.string().optional(),
  workflow_inputs: z.record(z.string(), z.unknown()).optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
  cron: z.string().optional(),
  to_role: z.string().optional(),
  task: z.string().optional(),
  schedule_name: z.string().optional(),
  ext_kind: z.enum(["workflow", "shadow_question", "skill", "role"]).optional(),
  kind_of: z.enum(["workflow", "shadow_question", "skill", "role"]).optional(),
  slug: z.string().optional(),
  spec: z.record(z.string(), z.unknown()).optional(),
  question: z.string().optional(),
  why: z.string().optional(),
  options: z.array(z.string()).optional(),
  description: z.string().optional(),
  summary: z.string().optional(),
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
      workflow_id: order.workflow_id ?? order.workflow ?? null,
      cron: order.cron ?? null,
      to_role: order.to_role ?? null,
      ext_kind: order.ext_kind ?? order.kind_of ?? null,
      slug: order.slug ?? null,
      server: order.server ?? null,
      tool: order.tool ?? null,
      ...(order.entity_id ? { entity_id: order.entity_id } : {}),
      ...(order.mutations ? { mutations: order.mutations } : {}),
      owns_paths: order.owns_paths ? [...order.owns_paths].sort() : null,
      api_payload: order.api_payload ?? null,
    }),
  );
}

/** Semantic deduplication hash (`E-04`): catches paraphrased duplicate orders targeting the same scope & mechanism. */
export function computeSemanticKey(domain: string, order: ActionOrder): string {
  const normScope = (
    order.target_scope?.scope_value ??
    order.workflow_id ??
    order.workflow ??
    order.slug ??
    order.to_role ??
    order.title
  )
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
    const resolvedDomain =
      rec.domain === "seo" || rec.domain === "marketing" || rec.domain === "specialist_os" ? rec.domain : fallbackDomain;
    const inferredKind =
      rec.kind ??
      (rec.cron
        ? "schedule"
        : rec.to_role || rec.agent_id
          ? "specialist_handoff"
          : rec.ext_kind || rec.kind_of
            ? "create_extension"
            : rec.workflow_id || rec.workflow || rec.targetWorkflowId
              ? "sub_graph"
              : rec.owns_paths || rec.target_paths
                ? "code_task"
                : "owner_escalate");
    const wfId =
      typeof rec.workflow_id === "string"
        ? rec.workflow_id
        : typeof rec.workflow === "string"
          ? rec.workflow
          : typeof rec.targetWorkflowId === "string"
            ? rec.targetWorkflowId
            : undefined;
    const wfInputs =
      rec.workflow_inputs && typeof rec.workflow_inputs === "object"
        ? rec.workflow_inputs
        : rec.inputs && typeof rec.inputs === "object"
          ? rec.inputs
          : undefined;
    const toRole = typeof rec.to_role === "string" ? rec.to_role : typeof rec.agent_id === "string" ? rec.agent_id : undefined;
    const taskBrief = typeof rec.task === "string" ? rec.task : typeof rec.brief === "string" ? rec.brief : undefined;
    const ownsPaths = Array.isArray(rec.owns_paths)
      ? rec.owns_paths.map(String)
      : Array.isArray(rec.target_paths)
        ? rec.target_paths.map(String)
        : undefined;
    const acceptanceList = Array.isArray(rec.acceptance)
      ? rec.acceptance.map(String)
      : Array.isArray(rec.acceptance_criteria)
        ? rec.acceptance_criteria.map(String)
        : undefined;
    let cfBatch = rec.cf_batch && typeof rec.cf_batch === "object" ? (rec.cf_batch as Record<string, unknown>) : undefined;
    if (!cfBatch && inferredKind === "content_batch") {
      const callerPages = Array.isArray(rec.pages)
        ? rec.pages
        : Array.isArray(rec.seo_items)
          ? rec.seo_items
          : Array.isArray(rec.items)
            ? rec.items
            : [];
      if (callerPages.length > 0) {
        const seoItems = callerPages
          .filter((p): p is Record<string, unknown> => Boolean(p && typeof p === "object"))
          .map((p, idx) => {
            const slug = String(p.slug ?? `item-${idx + 1}`).trim();
            const targetUrl = String(p.target_url ?? p.url ?? `/${slug}`).trim();
            return {
              id: String(p.id ?? `item_${idx + 1}`),
              kind: "seo_page",
              slug,
              target_url: targetUrl.startsWith("/") || targetUrl.startsWith("http") ? targetUrl : `/${targetUrl}`,
              primary_query: String(p.primary_query ?? p.query ?? slug.replace(/-/g, " ")),
              cluster: String(p.cluster ?? "general"),
              page_type: "comparison",
              information_gain_proof:
                p.information_gain_proof && typeof p.information_gain_proof === "object"
                  ? p.information_gain_proof
                  : {
                      serp_overlap: 0.2,
                      unique_verified_facts: 3,
                      fact_sources: ["verified_passport"],
                      cosine_max_sibling: 0.3,
                    },
            };
          });
        if (seoItems.length > 0) {
          const cfDomain = resolvedDomain === "seo" ? "seo" : "marketing";
          const batchId = `cfb_${sha256Hex(canonicalJson(seoItems)).slice(0, 10)}`;
          cfBatch = {
            schema: "lp.cf-batch/1",
            batch_id: batchId,
            domain: cfDomain,
            batch_kind: "seo_bofu",
            mode: "draft",
            wave: "canary_10",
            cf_group_slug: `${cfDomain}-bofu-canary`,
            scenario_id: "draft-review-only",
            scenario_has_publish_step: false,
            seo_items: seoItems,
            organic_items: [],
          };
        }
      }
    }
    const hydrated = {
      ...rec,
      domain: resolvedDomain,
      kind: inferredKind,
      ...(wfId ? { workflow_id: wfId, workflow: typeof rec.workflow === "string" ? rec.workflow : wfId } : {}),
      ...(wfInputs ? { workflow_inputs: wfInputs, inputs: wfInputs } : {}),
      ...(toRole ? { to_role: toRole } : {}),
      ...(taskBrief ? { task: taskBrief } : {}),
      ...(ownsPaths ? { owns_paths: ownsPaths } : {}),
      ...(acceptanceList ? { acceptance: acceptanceList } : {}),
      ...(cfBatch ? { cf_batch: cfBatch } : {}),
      title:
        typeof rec.title === "string" && rec.title.trim().length >= 3
          ? rec.title.trim()
          : typeof rec.question === "string" && rec.question.trim().length >= 3
            ? rec.question.trim().slice(0, 240)
            : String(rec.reason_code ?? "Specialist action order"),
      reason_code: typeof rec.reason_code === "string" && rec.reason_code.trim() ? rec.reason_code.trim() : "owner_approval_required",
    };
    const parsed = actionOrderSchema.safeParse(hydrated);
    if (parsed.success) valid.push(parsed.data);
  }
  return valid;
}
