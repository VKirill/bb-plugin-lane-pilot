import { z } from "zod";

export const CLAIM_STATUSES = ["confirmed", "hypothesis", "unknown", "taboo"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const PASSPORT_STAGES = [
  "idea_zero",
  "mvp",
  "mvp_pre_revenue",
  "live_cold",
  "early_traction",
  "scaling",
  "unknown",
] as const;
export type PassportStage = (typeof PASSPORT_STAGES)[number];

export const PASSPORT_SECTIONS = [
  "identity",
  "market_rails",
  "positioning",
  "audience_jtbd",
  "messaging_voice",
  "economics_funnel",
  "proof_brandcore",
  "product_design_rails",
] as const;
export type PassportSectionId = (typeof PASSPORT_SECTIONS)[number];

export function claimOf<V>(valueSchema: z.ZodType<V>, emptyValue: Exclude<V, undefined>): z.ZodType<Claim<V>> {
  const inner = z.object({
    status: z.enum(CLAIM_STATUSES).default("unknown"),
    value: z.preprocess((v) => (v === undefined ? emptyValue : v), valueSchema),
    evidence_ref: z.string().default(""),
    updated_at: z.number().int().optional(),
    note: z.string().optional(),
  });
  return z.preprocess(
    (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : { status: "unknown", value: emptyValue, evidence_ref: "" }),
    inner,
  ) as unknown as z.ZodType<Claim<V>>;
}

export type Claim<T> = {
  status: ClaimStatus;
  value: T;
  evidence_ref: string;
  updated_at?: number | undefined;
  note?: string | undefined;
};

const strClaim = () => claimOf(z.string(), "");
const strListClaim = () => claimOf(z.array(z.string()), []);
const boolClaim = (def = false) => claimOf(z.boolean(), def);
const numClaim = (def = 0) => claimOf(z.number(), def);

function objSection<S extends z.ZodRawShape>(shape: S) {
  const inner = z.object(shape);
  return z.preprocess((v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {}), inner);
}

export const passportV1Schema = z.object({
  schema_version: z.literal(1).default(1),
  identity: objSection({
    project_name: strClaim(),
    one_liner: strClaim(),
    stage: claimOf(z.enum(PASSPORT_STAGES), "unknown"),
    product_kind: strClaim(),
    primary_url: strClaim(),
    repo_summary: strClaim(),
    non_goals: strListClaim(),
  }),
  market_rails: objSection({
    ui_locales: strListClaim(),
    content_locales: strListClaim(),
    primary_countries: strListClaim(),
    excluded_countries: strListClaim(),
    currency: strClaim(),
    payment_rails: strListClaim(),
    compliance_regimes: strListClaim(),
    cultural_trust_code: strClaim(),
    allowed_channels: strListClaim(),
    forbidden_channels: strListClaim(),
  }),
  positioning: objSection({
    status_quo_alternatives: strListClaim(),
    unique_attributes: strListClaim(),
    core_value: strClaim(),
    best_fit_icp: strClaim(),
    market_category: strClaim(),
    market_sophistication: strClaim(),
    relevant_trend: strClaim(),
  }),
  audience_jtbd: objSection({
    payer_vs_user: strClaim(),
    trigger_event: strClaim(),
    four_forces: objSection({
      push: strClaim(),
      pull: strClaim(),
      anxiety: strClaim(),
      habit: strClaim(),
    }),
    decision_criteria: strListClaim(),
    awareness_level: strClaim(),
    anti_audience: strListClaim(),
  }),
  messaging_voice: objSection({
    hero_internal_problem: strClaim(),
    guide_empathy_authority: strClaim(),
    three_step_plan: strListClaim(),
    grunt_test: strClaim(),
    tone_of_voice: strClaim(),
    owner_lexicon: strListClaim(),
    banned_words: strListClaim(),
  }),
  economics_funnel: objSection({
    pricing_model: strClaim(),
    price_point: strClaim(),
    sales_motion: strClaim(),
    max_cac: strClaim(),
    ltv_estimate: strClaim(),
    maturity_window_days: numClaim(14),
    funnel_steps: strListClaim(),
  }),
  proof_brandcore: objSection({
    pre_launch_zero_proof: boolClaim(false),
    verified_facts: strListClaim(),
    credentials_eeat: strListClaim(),
    case_patterns: strListClaim(),
    forbidden_claims: strListClaim(),
  }),
  product_design_rails: objSection({
    core_jobs: strListClaim(),
    devices: strListClaim(),
    visual_references: strListClaim(),
    anti_references: strListClaim(),
    domain_glossary: strListClaim(),
    constraints: strListClaim(),
  }),
});

export type PassportV1 = z.infer<typeof passportV1Schema>;

export interface VerbatimEntry {
  id: string;
  project_id: string;
  scope_key: string;
  source: string;
  thread_id: string | null;
  run_id: string | null;
  question_asked: string;
  owner_verbatim: string;
  extracted_paths: string[];
  created_at: number;
}

export interface PendingPassportDelta {
  id: string;
  project_id: string;
  scope_key: string;
  field_path: string;
  old_claim: Claim<unknown>;
  proposed_claim: Claim<unknown>;
  verbatim_id: string | null;
  reason: string;
  state: "pending" | "accepted" | "rejected";
  created_at: number;
  decided_at: number | null;
}

export interface PassportContradiction {
  code: string;
  severity: "high" | "medium";
  fields: string;
  detail: string;
  fix: string;
}

export interface PassportFluffWarning {
  code: string;
  field_path: string;
  matched: string;
  status: ClaimStatus;
  remediation: string;
}

export interface PassportQuestion {
  id: string;
  section: PassportSectionId;
  field_path: string;
  framework: string;
  question_ru: string;
  question_en: string;
  anti_fluff_probe: string;
}

export interface PassportMetrics {
  completeness_score: number;
  confirmed_count: number;
  hypothesis_count: number;
  unknown_count: number;
  taboo_count: number;
  section_scores: Record<PassportSectionId, number>;
  readiness_by_domain: Record<string, { score: number; ready: boolean; thin_sections: PassportSectionId[] }>;
}

const SECTION_WEIGHTS: Record<PassportSectionId, number> = {
  identity: 0.14,
  market_rails: 0.18,
  positioning: 0.16,
  audience_jtbd: 0.16,
  messaging_voice: 0.10,
  economics_funnel: 0.10,
  proof_brandcore: 0.08,
  product_design_rails: 0.08,
};

const DOMAIN_SECTIONS: Record<string, readonly PassportSectionId[]> = {
  code: ["identity", "market_rails", "product_design_rails"],
  design: ["identity", "market_rails", "positioning", "messaging_voice", "product_design_rails"],
  seo: ["identity", "market_rails", "positioning", "audience_jtbd", "proof_brandcore"],
  marketing: ["identity", "market_rails", "positioning", "audience_jtbd", "messaging_voice", "economics_funnel", "proof_brandcore"],
  content: ["identity", "market_rails", "positioning", "audience_jtbd", "messaging_voice"],
  research: ["identity", "market_rails", "positioning", "audience_jtbd"],
  games: ["identity", "market_rails", "audience_jtbd", "product_design_rails"],
  business: ["identity", "market_rails", "economics_funnel"],
};

export function createEmptyPassport(): PassportV1 {
  return passportV1Schema.parse({});
}

export function isClaimEnvelope(val: unknown): val is Claim<unknown> {
  return Boolean(val && typeof val === "object" && "status" in (val as Record<string, unknown>) && "value" in (val as Record<string, unknown>));
}

export function isClaimFilled(val: unknown): boolean {
  if (val === null || val === undefined) return false;
  if (typeof val === "boolean") return true;
  if (typeof val === "number") return Number.isFinite(val);
  if (typeof val === "string") return val.trim().length > 0 && val !== "unknown";
  if (Array.isArray(val)) return val.length > 0 && val.some((x) => isClaimFilled(x));
  if (typeof val === "object") return Object.values(val as Record<string, unknown>).some((v) => isClaimFilled(v));
  return false;
}

export function formatClaimValue(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "string") return val.trim();
  if (typeof val === "boolean" || typeof val === "number") return String(val);
  if (Array.isArray(val)) return val.map((item) => formatClaimValue(item)).filter(Boolean).join(", ");
  if (typeof val === "object") {
    return Object.entries(val as Record<string, unknown>)
      .map(([k, v]) => {
        const inner = formatClaimValue(v);
        return inner ? `${k}: ${inner}` : "";
      })
      .filter(Boolean)
      .join("; ");
  }
  return String(val);
}

export function walkPassportClaims(
  node: unknown,
  prefix = "",
): Array<{ path: string; status: ClaimStatus; value: unknown; evidence_ref: string; note?: string | undefined }> {
  if (isClaimEnvelope(node)) {
    const rawStatus = CLAIM_STATUSES.includes(node.status) ? node.status : "unknown";
    const effectiveStatus: ClaimStatus =
      rawStatus !== "unknown" && !isClaimFilled(node.value) ? "unknown" : rawStatus;
    return [
      {
        path: prefix,
        status: effectiveStatus,
        value: node.value,
        evidence_ref: typeof node.evidence_ref === "string" ? node.evidence_ref : "",
        ...(typeof node.note === "string" && node.note ? { note: node.note } : {}),
      },
    ];
  }
  if (!node || typeof node !== "object" || Array.isArray(node)) return [];
  const out: Array<{ path: string; status: ClaimStatus; value: unknown; evidence_ref: string; note?: string | undefined }> = [];
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "schema_version" || k.startsWith("_")) continue;
    const sub = prefix ? `${prefix}.${k}` : k;
    out.push(...walkPassportClaims(v, sub));
  }
  return out;
}

export function getPassportClaimAt(passport: PassportV1, dottedPath: string): Claim<unknown> | null {
  let cur: unknown = passport;
  for (const part of dottedPath.split(".")) {
    if (!cur || typeof cur !== "object" || !(part in (cur as Record<string, unknown>))) return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return isClaimEnvelope(cur) ? cur : null;
}

function coercePatchLeaf(existing: Claim<unknown>, incoming: unknown, defaultEvidenceRef: string, now: number): Claim<unknown> {
  if (isClaimEnvelope(incoming)) {
    const rawStatus = CLAIM_STATUSES.includes(incoming.status as ClaimStatus) ? (incoming.status as ClaimStatus) : "confirmed";
    const nextVal = incoming.value !== undefined ? coerceTypeToExisting(existing.value, incoming.value) : existing.value;
    if (rawStatus === "unknown" && !isClaimFilled(nextVal)) {
      // Do not erase an already filled claim with a blank unknown unless explicitly cleared
      if (existing.status !== "unknown" && isClaimFilled(existing.value) && incoming.value === undefined) return existing;
    }
    const status: ClaimStatus = rawStatus !== "unknown" && !isClaimFilled(nextVal) ? "unknown" : rawStatus;
    return {
      status,
      value: nextVal,
      evidence_ref: (typeof incoming.evidence_ref === "string" && incoming.evidence_ref.trim()) || defaultEvidenceRef || existing.evidence_ref || "",
      updated_at: incoming.updated_at ?? now,
      ...(typeof incoming.note === "string" && incoming.note ? { note: incoming.note } : existing.note ? { note: existing.note } : {}),
    };
  }
  // Plain shorthand value (e.g. `"LedgerPulse"` or `["en-US"]`) -> treat as confirmed if non-empty
  const coerced = coerceTypeToExisting(existing.value, incoming);
  if (!isClaimFilled(coerced)) return existing;
  return {
    status: "confirmed",
    value: coerced,
    evidence_ref: defaultEvidenceRef || existing.evidence_ref || "manual",
    updated_at: now,
  };
}

function coerceTypeToExisting(template: unknown, val: unknown): unknown {
  if (Array.isArray(template)) {
    if (Array.isArray(val)) return val.map((x) => String(x).trim()).filter(Boolean);
    if (typeof val === "string") {
      return val
        .split(/[,;\n]+/)
        .map((x) => x.trim())
        .filter(Boolean);
    }
    return [];
  }
  if (typeof template === "boolean") {
    if (typeof val === "boolean") return val;
    if (typeof val === "string") return ["true", "1", "yes", "да"].includes(val.trim().toLowerCase());
    return Boolean(val);
  }
  if (typeof template === "number") {
    const n = typeof val === "number" ? val : Number(val);
    return Number.isFinite(n) ? n : template;
  }
  if (typeof template === "string") {
    if (typeof val === "string") return val.trim();
    if (Array.isArray(val)) return val.map(String).join(", ");
    return val === null || val === undefined ? "" : String(val);
  }
  return val;
}

function mergeNodeRecursive(existingNode: Record<string, unknown>, patchNode: Record<string, unknown>, evidenceRef: string, now: number): Record<string, unknown> {
  const result: Record<string, unknown> = { ...existingNode };
  for (const [k, existingVal] of Object.entries(existingNode)) {
    if (!(k in patchNode) || patchNode[k] === undefined) continue;
    const incomingVal = patchNode[k];
    if (isClaimEnvelope(existingVal)) {
      result[k] = coercePatchLeaf(existingVal, incomingVal, evidenceRef, now);
    } else if (existingVal && typeof existingVal === "object" && !Array.isArray(existingVal) && incomingVal && typeof incomingVal === "object" && !Array.isArray(incomingVal)) {
      result[k] = mergeNodeRecursive(existingVal as Record<string, unknown>, incomingVal as Record<string, unknown>, evidenceRef, now);
    }
  }
  return result;
}

/**
 * Merges either nested section patches OR dotted path keys (`{"market_rails.currency": "USD"}`) into a validated `PassportV1`.
 */
export function mergePassportPatch(
  base: PassportV1,
  patch: Record<string, unknown>,
  options: { evidenceRef?: string; now?: number } = {},
): PassportV1 {
  const now = options.now ?? Date.now();
  const evidenceRef = options.evidenceRef ?? "";
  const expandedPatch: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(patch)) {
    if (key.includes(".")) {
      const parts = key.split(".");
      let cur = expandedPatch;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const p = parts[i]!;
        if (!cur[p] || typeof cur[p] !== "object" || isClaimEnvelope(cur[p])) cur[p] = {};
        cur = cur[p] as Record<string, unknown>;
      }
      cur[parts[parts.length - 1]!] = val;
    } else {
      expandedPatch[key] = val;
    }
  }

  const merged = mergeNodeRecursive(base as unknown as Record<string, unknown>, expandedPatch, evidenceRef, now);
  return passportV1Schema.parse(merged);
}

export function extractFlatPatchClaims(before: PassportV1, after: PassportV1): string[] {
  const prevMap = new Map(walkPassportClaims(before).map((c) => [c.path, JSON.stringify({ s: c.status, v: c.value })]));
  const changed: string[] = [];
  for (const c of walkPassportClaims(after)) {
    if (prevMap.get(c.path) !== JSON.stringify({ s: c.status, v: c.value })) {
      changed.push(c.path);
    }
  }
  return changed;
}

export function computePassportMetrics(passport: PassportV1): PassportMetrics {
  const sectionScores = {} as Record<PassportSectionId, number>;
  let confirmedCount = 0;
  let hypothesisCount = 0;
  let unknownCount = 0;
  let tabooCount = 0;

  for (const sec of PASSPORT_SECTIONS) {
    const claims = walkPassportClaims(passport[sec], sec);
    if (!claims.length) {
      sectionScores[sec] = 0;
      continue;
    }
    let earned = 0;
    for (const c of claims) {
      if (c.status === "confirmed") {
        confirmedCount += 1;
        earned += 1.0;
      } else if (c.status === "taboo") {
        tabooCount += 1;
        earned += 1.0;
      } else if (c.status === "hypothesis") {
        hypothesisCount += 1;
        earned += 0.65;
      } else {
        unknownCount += 1;
      }
    }
    sectionScores[sec] = Math.round((100 * earned) / claims.length);
  }

  const completenessScore = Math.round(
    PASSPORT_SECTIONS.reduce((acc, sec) => acc + sectionScores[sec] * SECTION_WEIGHTS[sec], 0),
  );

  const readinessByDomain: PassportMetrics["readiness_by_domain"] = {};
  for (const [dom, reqSecs] of Object.entries(DOMAIN_SECTIONS)) {
    const avg = Math.round(reqSecs.reduce((acc, s) => acc + sectionScores[s], 0) / Math.max(1, reqSecs.length));
    const thin = reqSecs.filter((s) => sectionScores[s] < 40);
    readinessByDomain[dom] = {
      score: avg,
      ready: avg >= 55 && !thin.includes("identity") && !thin.includes("market_rails"),
      thin_sections: [...thin],
    };
  }

  return {
    completeness_score: completenessScore,
    confirmed_count: confirmedCount,
    hypothesis_count: hypothesisCount,
    unknown_count: unknownCount,
    taboo_count: tabooCount,
    section_scores: sectionScores,
    readiness_by_domain: readinessByDomain,
  };
}
