import { maskCredentials } from "@lane-pilot/kit";
import type { LanePilotDatabase } from "../storage";
import { detectPassportContradictions, passportExcludesRu } from "./passport-checks-and-render";
import {
  formatClaimValue,
  isClaimFilled,
  walkPassportClaims,
  type Claim,
  type PassportV1,
  type VerbatimEntry,
} from "./schema";
import { getPassport, listVerbatim } from "./store";

/**
 * Personal-biography workflows belong strictly to the owner's `anamnesis` contour, never to a commercial project's passport.
 */
export const PERSONAL_ANAMNESIS_WORKFLOWS = new Set([
  "profile-user",
  "resume",
  "year-review",
  "about-site",
]);

/**
 * Workflows locked to Russian domestic platforms/regulations that must be flagged when `market_rails` excludes RU.
 */
const RU_LOCKED_WORKFLOWS: Record<string, string> = {
  "mkt-direct-search-campaign": "Yandex Direct search campaign (RU/EAEU ad network + ORD erid)",
  "invoice-send": "Kontur.Elba RUB invoice (Russian tax/accounting rail)",
  "billing-batch": "Kontur.Elba RUB batch billing (Russian tax/accounting rail)",
};

export interface PassportLensSelector {
  role?: string | undefined;
  workflowId?: string | undefined;
  category?: string | undefined;
  maxChars?: number | undefined;
}

type LensProfile = "code" | "design" | "marketing" | "seo" | "content" | "games" | "pm_lead";

function classifyLensProfile(sel: PassportLensSelector): LensProfile {
  const r = (sel.role ?? "").replace(/^specialist:/, "").toLowerCase();
  const wf = (sel.workflowId ?? "").toLowerCase();
  const cat = (sel.category ?? "").toLowerCase();

  if (r === "seo-specialist" || wf.startsWith("seo-") || cat === "seo") return "seo";
  if (r === "growth-marketer" || wf.startsWith("mkt-") || cat === "marketing") return "marketing";
  if (r === "copy-lead" || r === "video-lead" || r === "social-manager" || cat === "content" || wf === "reels" || wf === "social-post") {
    return "content";
  }
  if (r === "design-lead" || wf === "impeccable-build" || wf === "lp.draw" || wf === "ui-audit") return "design";
  if (r === "3d-artist" || r === "game-dev" || cat === "games" || wf === "3d-asset" || wf === "roblox-asset") return "games";
  if (
    r === "writer" ||
    r === "code-critic" ||
    r === "debugger" ||
    wf.startsWith("lp.") && (wf === "lp.analyze" || wf === "lp.plan" || wf === "lp.browser-qa" || wf === "lp-task-pipeline")
  ) {
    return "code";
  }
  return "pm_lead";
}

function lineIfFilled(label: string, claim: Claim<unknown>): string | null {
  if (claim.status === "unknown" || !isClaimFilled(claim.value)) return null;
  const tag =
    claim.status === "hypothesis"
      ? " [HYPOTHESIS — validate, do not state as proven fact]"
      : claim.status === "taboo"
        ? " [TABOO / FORBIDDEN]"
        : "";
  return `- ${label}${tag}: ${formatClaimValue(claim.value)}`;
}

/**
 * Builds a compact, high-signal role-tailored slice (typically 400–900 tokens) of `PassportV1` + verbatim quotes.
 * Returns `""` when the passport has zero filled claims.
 */
export function passportLensFor(
  passport: PassportV1,
  verbatim: readonly VerbatimEntry[] = [],
  selector: PassportLensSelector = {},
): string {
  if (selector.workflowId && PERSONAL_ANAMNESIS_WORKFLOWS.has(selector.workflowId)) return "";
  const allFilled = walkPassportClaims(passport).filter((c) => c.status !== "unknown" && isClaimFilled(c.value));
  if (allFilled.length === 0) return "";

  const profile = classifyLensProfile(selector);
  const maxChars = Math.max(600, Math.min(4_500, selector.maxChars ?? 2_400));
  const lines: string[] = [];

  const name = formatClaimValue(passport.identity.project_name.value) || "Current Project";
  const stage = passport.identity.stage.value !== "unknown" ? ` (${passport.identity.stage.value})` : "";
  lines.push(`<project_passport project="${name}${stage}" lens="${profile}">`);
  lines.push(" Epistemic rule: [HYPOTHESIS] = unverified startup assumption (do NOT invent fake proof); unstated/unknown fields = NEVER hallucinate; [TABOO] = hard prohibition.");

  // 1. Always-on Identity + Market & Language Rails (prevents cross-country / cross-language leaks!)
  const rails: string[] = [];
  const oneLiner = lineIfFilled("Project", passport.identity.one_liner);
  if (oneLiner) rails.push(oneLiner);
  const primaryUrl = lineIfFilled("Primary URL", passport.identity.primary_url);
  if (primaryUrl) rails.push(primaryUrl);
  const uiLoc = lineIfFilled("UI locales", passport.market_rails.ui_locales);
  if (uiLoc) rails.push(uiLoc);
  const contentLoc = lineIfFilled("Content locales", passport.market_rails.content_locales);
  if (contentLoc) rails.push(contentLoc);
  const countries = lineIfFilled("Target countries", passport.market_rails.primary_countries);
  if (countries) rails.push(countries);
  const exCountries = lineIfFilled("Excluded countries", passport.market_rails.excluded_countries);
  if (exCountries) rails.push(exCountries);
  const currency = lineIfFilled("Currency", passport.market_rails.currency);
  if (currency) rails.push(currency);
  const pay = lineIfFilled("Payment rails", passport.market_rails.payment_rails);
  if (pay) rails.push(pay);
  const comp = lineIfFilled("Compliance", passport.market_rails.compliance_regimes);
  if (comp) rails.push(comp);
  const forbChan = lineIfFilled("Forbidden channels", passport.market_rails.forbidden_channels);
  if (forbChan) rails.push(forbChan);

  if (passportExcludesRu(passport)) {
    rails.push("- HARD LOCALE GUARD: Non-RU target market — NEVER output Russian UI copy, RUB/₽, +7 phones, 152-FZ, ORD erid, YooKassa, or Yandex Direct recommendations unless explicitly requested.");
  }
  if (passport.proof_brandcore.pre_launch_zero_proof.value === true || passport.identity.stage.value === "idea_zero") {
    rails.push("- ZERO-PROOF GUARD: Project is pre-launch / zero-case — NEVER fabricate customer reviews, client counts, or fake case studies.");
  }

  if (rails.length) {
    lines.push(" [Identity & Market Rails]");
    lines.push(...rails);
  }

  // 2. Role-specific body
  const body: string[] = [];
  const add = (label: string, claim: Claim<unknown>) => {
    const l = lineIfFilled(label, claim);
    if (l) body.push(l);
  };

  if (profile === "code") {
    add("Best-fit ICP", passport.positioning.best_fit_icp);
    add("Core user jobs (MVP)", passport.product_design_rails.core_jobs);
    add("Target devices", passport.product_design_rails.devices);
    add("Domain glossary", passport.product_design_rails.domain_glossary);
    add("Technical constraints", passport.product_design_rails.constraints);
    add("Non-goals", passport.identity.non_goals);
  } else if (profile === "design") {
    add("Market category", passport.positioning.market_category);
    add("Best-fit ICP", passport.positioning.best_fit_icp);
    add("Core value", passport.positioning.core_value);
    add("5-second Grunt Test", passport.messaging_voice.grunt_test);
    add("Buyer anxiety before action", passport.audience_jtbd.four_forces.anxiety);
    add("Cultural trust code", passport.market_rails.cultural_trust_code);
    add("Core user jobs", passport.product_design_rails.core_jobs);
    add("Target devices", passport.product_design_rails.devices);
    add("Visual references", passport.product_design_rails.visual_references);
    add("Anti-references", passport.product_design_rails.anti_references);
    add("Banned words/clichés", passport.messaging_voice.banned_words);
  } else if (profile === "marketing") {
    add("Allowed channels", passport.market_rails.allowed_channels);
    add("Status-quo alternatives", passport.positioning.status_quo_alternatives);
    add("Unique attributes", passport.positioning.unique_attributes);
    add("Core value", passport.positioning.core_value);
    add("Best-fit ICP", passport.positioning.best_fit_icp);
    add("Awareness level", passport.audience_jtbd.awareness_level);
    add("Trigger event", passport.audience_jtbd.trigger_event);
    add("JTBD Push (pain)", passport.audience_jtbd.four_forces.push);
    add("JTBD Pull (outcome)", passport.audience_jtbd.four_forces.pull);
    add("JTBD Anxiety (barrier)", passport.audience_jtbd.four_forces.anxiety);
    add("5-second Grunt Test", passport.messaging_voice.grunt_test);
    add("Price / model", passport.economics_funnel.price_point);
    add("Sales motion", passport.economics_funnel.sales_motion);
    add("Max CAC", passport.economics_funnel.max_cac);
    add("Verified proof", passport.proof_brandcore.verified_facts);
    add("Forbidden claims", passport.proof_brandcore.forbidden_claims);
    add("Banned words", passport.messaging_voice.banned_words);
  } else if (profile === "seo") {
    add("Market category", passport.positioning.market_category);
    add("Best-fit ICP", passport.positioning.best_fit_icp);
    add("Status-quo alternatives", passport.positioning.status_quo_alternatives);
    add("Core value", passport.positioning.core_value);
    add("Trigger event", passport.audience_jtbd.trigger_event);
    add("Decision criteria", passport.audience_jtbd.decision_criteria);
    add("Awareness level", passport.audience_jtbd.awareness_level);
    add("Verified facts", passport.proof_brandcore.verified_facts);
    add("E-E-A-T credentials", passport.proof_brandcore.credentials_eeat);
    add("Forbidden claims", passport.proof_brandcore.forbidden_claims);
    add("Banned words", passport.messaging_voice.banned_words);
  } else if (profile === "content") {
    add("Best-fit ICP", passport.positioning.best_fit_icp);
    add("Status-quo alternatives", passport.positioning.status_quo_alternatives);
    add("Core value", passport.positioning.core_value);
    add("Hero internal problem", passport.messaging_voice.hero_internal_problem);
    add("JTBD Push", passport.audience_jtbd.four_forces.push);
    add("JTBD Anxiety", passport.audience_jtbd.four_forces.anxiety);
    add("Tone of voice", passport.messaging_voice.tone_of_voice);
    add("5-second Grunt Test", passport.messaging_voice.grunt_test);
    add("Owner verbatim lexicon", passport.messaging_voice.owner_lexicon);
    add("Banned words", passport.messaging_voice.banned_words);
    add("Forbidden claims", passport.proof_brandcore.forbidden_claims);
  } else if (profile === "games") {
    add("Product kind", passport.identity.product_kind);
    add("Best-fit audience", passport.positioning.best_fit_icp);
    add("Core jobs / loop", passport.product_design_rails.core_jobs);
    add("Target devices/platforms", passport.product_design_rails.devices);
    add("Visual & art references", passport.product_design_rails.visual_references);
    add("Anti-references", passport.product_design_rails.anti_references);
    add("Technical/poly constraints", passport.product_design_rails.constraints);
  } else {
    // pm_lead / council / research / router
    add("Market category", passport.positioning.market_category);
    add("Best-fit ICP", passport.positioning.best_fit_icp);
    add("Status-quo alternatives", passport.positioning.status_quo_alternatives);
    add("Core value", passport.positioning.core_value);
    add("Price / motion", passport.economics_funnel.price_point);
    add("Non-goals", passport.identity.non_goals);
    add("Forbidden claims", passport.proof_brandcore.forbidden_claims);
    const hypotheses = allFilled.filter((c) => c.status === "hypothesis").slice(0, 4);
    if (hypotheses.length) {
      body.push(`- Open hypotheses to validate: ${hypotheses.map((h) => `${h.path}="${formatClaimValue(h.value).slice(0, 60)}"`).join("; ")}`);
    }
  }

  if (body.length) {
    lines.push(" [Role Focus]");
    lines.push(...body);
  }

  // 3. Verbatim founder quotes for copy/marketing/design/PM fidelity
  if ((profile === "content" || profile === "marketing" || profile === "design" || profile === "pm_lead") && verbatim.length > 0) {
    const quotes = verbatim
      .slice(0, 3)
      .map((v) => `  • "${v.owner_verbatim.replace(/\s+/g, " ").trim().slice(0, 180)}"`);
    if (quotes.length) {
      lines.push(" [Owner Verbatim Voice]");
      lines.push(...quotes);
    }
  }

  lines.push("</project_passport>");
  const full = maskCredentials(lines.join("\n")).text;
  if (full.length <= maxChars) return full;
  return `${full.slice(0, maxChars - 26).trimEnd()}\n…\n</project_passport>`;
}

/**
 * Registered delivery primitive in `MEMORY_PRIMITIVES` (`src/rooms/memory/memory-paths.ts`).
 * Safe on any mock or unmigrated DB handle: returns `""` when no passport exists.
 */
export function projectPassportBlock(
  db: LanePilotDatabase,
  input: PassportLensSelector & { projectId: string; scopeKey?: string | undefined },
): string {
  if (!db || typeof db.prepare !== "function" || !input.projectId) return "";
  if (input.workflowId && PERSONAL_ANAMNESIS_WORKFLOWS.has(input.workflowId)) return "";
  const stored = getPassport(db, input.projectId, input.scopeKey ?? "");
  if (!stored) return "";
  const verbatim = listVerbatim(db, input.projectId, { scopeKey: input.scopeKey ?? "", limit: 4 });
  const lens = passportLensFor(stored.passport, verbatim, input);
  return lens ? `\n\n${lens}` : "";
}

/**
 * Checks whether launching `workflowId` violates the project's confirmed `market_rails` (e.g. launching Yandex Direct or Kontur.Elba on a US-only project).
 */
export function checkPassportMarketRail(
  db: LanePilotDatabase,
  projectId: string,
  workflowId: string,
  options?: { allowCrossMarket?: boolean | undefined },
): { ok: true; warnings: string[] } | { ok: false; reason: string } {
  const stored = getPassport(db, projectId);
  if (!stored) return { ok: true, warnings: [] };
  if (options?.allowCrossMarket === true) {
    const contradictions = detectPassportContradictions(stored.passport).map((c) => `${c.code}: ${c.detail}`);
    return { ok: true, warnings: contradictions };
  }
  const ruLockedDesc = RU_LOCKED_WORKFLOWS[workflowId];
  if (ruLockedDesc && passportExcludesRu(stored.passport)) {
    return {
      ok: false,
      reason: `market_rail_mismatch: workflow "${workflowId}" (${ruLockedDesc}) conflicts with this project's Living Passport market_rails (target countries: [${stored.passport.market_rails.primary_countries.value.join(", ")}], excluded: [${stored.passport.market_rails.excluded_countries.value.join(", ")}]). Update the Project Passport or pass allowCrossMarket: true if intentional.`,
    };
  }
  const contradictions = detectPassportContradictions(stored.passport).map((c) => `${c.code}: ${c.detail}`);
  return { ok: true, warnings: contradictions };
}
