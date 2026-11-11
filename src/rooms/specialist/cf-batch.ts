import { z } from "zod";
import { sha256Hex } from "@lane-pilot/kit";
import { canonicalJson } from "./action-order";

/**
 * Content Factory Bridge v1 contract (`lp.cf-batch/1`, `content-factory-bridge-spec.md` §§2–10).
 * Supports both SEO programmatic BOFU / cluster batches (`G-1..G-W`) and multi-channel organic
 * distribution units (`dzen_article | pinterest_pin | reels_script | blog_funnel_post`, `G-O1..G-O5`).
 */
export const cfInformationGainSchema = z.object({
  serp_overlap: z.number().min(0).max(1),
  unique_verified_facts: z.number().int().min(0),
  fact_sources: z.array(z.string().min(1)).default([]),
  cosine_max_sibling: z.number().min(0).max(1).default(0),
});

export const cfSeoItemSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("seo_page").default("seo_page"),
  slug: z.string().min(1),
  target_url: z.string().min(1),
  primary_query: z.string().min(1),
  cluster: z.string().min(1),
  page_type: z
    .enum(["comparison", "alternative", "migration", "integration", "pricing", "role_use_case", "article", "service"])
    .default("comparison"),
  information_gain_proof: cfInformationGainSchema,
});

export const cfOrganicChannelSchema = z.enum([
  "dzen_article",
  "pinterest_pin",
  "reels_script",
  "blog_funnel_post",
]);

export type CfOrganicChannel = z.infer<typeof cfOrganicChannelSchema>;

export const cfOrganicItemSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("organic"),
  channel: cfOrganicChannelSchema,
  slug: z.string().min(1),
  title: z.string().min(3),
  target_url: z.string().optional(),
  utm_campaign: z.string().min(2),
  utm_source: z.string().min(2).optional(),
  utm_medium: z.string().min(2).default("organic_social"),
  audit_score: z.number().min(0).max(100).optional(),
  audit_sha256: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
});

export const cfWaveSchema = z.enum(["canary_10", "wave_50", "full"]);
export type CfWave = z.infer<typeof cfWaveSchema>;

export const cfBatchSchema = z.object({
  schema: z.literal("lp.cf-batch/1"),
  batch_id: z.string().min(3),
  domain: z.enum(["seo", "marketing"]),
  batch_kind: z.enum(["seo_bofu", "seo_cluster", "organic_multi"]),
  mode: z.literal("draft").default("draft"),
  wave: cfWaveSchema.default("canary_10"),
  cf_group_slug: z.string().min(2),
  scenario_id: z.string().min(2).default("draft-review-only"),
  scenario_has_publish_step: z.boolean().default(false),
  seo_items: z.array(cfSeoItemSchema).default([]),
  organic_items: z.array(cfOrganicItemSchema).default([]),
});

export type CfBatch = z.infer<typeof cfBatchSchema>;

export interface CfGateResult {
  ok: boolean;
  verdict: "pass" | "block";
  batch_sha256: string;
  failed_gates: Array<{ gate: string; detail: string }>;
}

const WAVE_MAX_ITEMS: Record<CfWave, number> = {
  canary_10: 15,
  wave_50: 60,
  full: 500,
};

/**
 * Pure deterministic pre-flight check (`G-1..G-W` for SEO items, `G-O1..G-O4` structural checks for Organic items).
 * Gate `G-O5` (running `audit_organic_pack.py --strict`) and wave progression (`G-15` DB check) run in `sp-cf-adapter.ts`.
 */
export function validateCfBatchPreFlight(
  batch: CfBatch,
  opts: { previousWaveCompleted?: boolean; previousIndexationRate14d?: number | null } = {},
): CfGateResult {
  const failed: Array<{ gate: string; detail: string }> = [];
  const totalItems = batch.seo_items.length + batch.organic_items.length;

  if (totalItems === 0) {
    failed.push({ gate: "G-1_non_empty", detail: "batch contains 0 items" });
  }
  if (batch.scenario_has_publish_step) {
    failed.push({
      gate: "G-2_draft_only_scenario",
      detail: `scenario "${batch.scenario_id}" contains a live publish step; Content Factory bridge v1 allows drafts only`,
    });
  }
  const waveCap = WAVE_MAX_ITEMS[batch.wave];
  if (totalItems > waveCap) {
    failed.push({
      gate: "G-W_wave_cap",
      detail: `wave "${batch.wave}" allows at most ${waveCap} items, got ${totalItems}`,
    });
  }
  if (batch.wave !== "canary_10") {
    if (!opts.previousWaveCompleted) {
      failed.push({
        gate: "G-15_canary_prerequisite",
        detail: `wave "${batch.wave}" requires completed prior canary wave`,
      });
    } else if (
      batch.batch_kind !== "organic_multi" &&
      typeof opts.previousIndexationRate14d === "number" &&
      opts.previousIndexationRate14d < 0.65
    ) {
      failed.push({
        gate: "G-15_indexation_gate",
        detail: `previous batch 14d indexation rate ${opts.previousIndexationRate14d.toFixed(2)} < 0.65`,
      });
    }
  }

  const seenUrls = new Set<string>();
  for (const item of batch.seo_items) {
    const normUrl = item.target_url.trim().toLowerCase();
    if (seenUrls.has(normUrl)) {
      failed.push({ gate: "G-3_unique_url", detail: `duplicate target_url "${item.target_url}"` });
    }
    seenUrls.add(normUrl);
    if (item.information_gain_proof.serp_overlap >= 0.4) {
      failed.push({
        gate: "G-4_serp_overlap",
        detail: `${item.id}: serp_overlap ${item.information_gain_proof.serp_overlap} >= 0.40 (merge into parent H2 instead)`,
      });
    }
    if (item.information_gain_proof.unique_verified_facts < 3) {
      failed.push({
        gate: "G-5_verified_facts",
        detail: `${item.id}: unique_verified_facts ${item.information_gain_proof.unique_verified_facts} < 3`,
      });
    }
    if (item.information_gain_proof.cosine_max_sibling >= 0.72) {
      failed.push({
        gate: "G-6_sibling_cosine",
        detail: `${item.id}: cosine_max_sibling ${item.information_gain_proof.cosine_max_sibling} >= 0.72`,
      });
    }
  }

  const seenOrganicSlugs = new Set<string>();
  for (const item of batch.organic_items) {
    const key = `${item.channel}:${item.slug.trim().toLowerCase()}`;
    if (seenOrganicSlugs.has(key)) {
      failed.push({ gate: "G-O1_unique_slug", detail: `duplicate organic unit "${key}"` });
    }
    seenOrganicSlugs.add(key);
    if (!item.utm_campaign || item.utm_campaign.trim().length < 2) {
      failed.push({ gate: "G-O2_utm_campaign", detail: `${item.id}: missing utm_campaign` });
    }
    if (item.channel === "pinterest_pin" && !item.target_url) {
      failed.push({ gate: "G-O3_pinterest_link", detail: `${item.id}: pinterest_pin requires target_url with UTM` });
    }
    if (typeof item.audit_score === "number" && item.audit_score < 70) {
      failed.push({ gate: "G-O4_min_audit_score", detail: `${item.id}: audit_score ${item.audit_score} < 70` });
    }
  }

  const batch_sha256 = sha256Hex(
    canonicalJson({
      domain: batch.domain,
      batch_kind: batch.batch_kind,
      cf_group_slug: batch.cf_group_slug,
      seo_items: batch.seo_items.map((x) => ({ id: x.id, url: x.target_url, q: x.primary_query })),
      organic_items: batch.organic_items.map((x) => ({ id: x.id, ch: x.channel, slug: x.slug })),
    }),
  );

  return {
    ok: failed.length === 0,
    verdict: failed.length === 0 ? "pass" : "block",
    batch_sha256,
    failed_gates: failed,
  };
}
