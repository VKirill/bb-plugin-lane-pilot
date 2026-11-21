import { redactKnown } from "@lane-pilot/kit";
import { WORKFLOW_CATEGORIES, isBuiltinWorkflowCategory } from "../workflow";

export type TaxonomyLogLevel = "debug" | "info" | "warn" | "error" | "silent";

export type TaxonomyViolation = {
  readonly code: "niche_category_violation" | "niche_workflow_identity";
  readonly path: string;
  readonly detail: string;
  readonly matchedToken: string;
};

export const BROAD_DYNAMIC_CATEGORIES: Readonly<Record<string, { en: string; ru: string }>> = {
  websites: { en: "Websites & Web Design", ru: "Сайты и веб-дизайн" },
  branding: { en: "Branding & Identity", ru: "Брендинг и айдентика" },
  marketing: { en: "Marketing & Funnels", ru: "Маркетинг и воронки" },
  content: { en: "Content & Editorial", ru: "Контент и редактура" },
  analytics: { en: "Research & Analytics", ru: "Исследования и аналитика" },
  operations: { en: "Operations", ru: "Операционные процессы" },
  media: { en: "Media & Production", ru: "Медиа и продакшн" },
};

const BUILTIN_CATEGORY_LABELS: Readonly<Record<string, { en: string; ru: string }>> = {
  seo: { en: "SEO", ru: "SEO" },
  marketing: { en: "Marketing", ru: "Маркетинг" },
  code: { en: "Code & Development", ru: "Код и разработка" },
  content: { en: "Content", ru: "Контент" },
  research: { en: "Research", ru: "Исследования" },
  games: { en: "Games & 3D", ru: "Игры и 3D" },
  business: { en: "Business & Finance", ru: "Бизнес и финансы" },
  routines: { en: "Routines", ru: "Рутины" },
  service: { en: "Service & Platform", ru: "Служебные" },
};

const EXTRA_BROAD_CATEGORY_IDS = new Set([
  "design",
  "sales",
  "support",
  "product",
  "finance",
  "legal",
  "hr",
  "education",
  "release",
  "analytics-ops",
  "bi-reporting",
]);

const LOG_RANK: Readonly<Record<TaxonomyLogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

const CATEGORY_SLUG_RE = /^[a-z][a-z0-9-]*$/;

const NICHE_SLUG_PATTERNS: readonly RegExp[] = [
  /^pbs(?:-|$)/i,
  /(?:^|-)personal-brand(?:-|$)/i,
  /(?:^|-)plastic-windows?(?:-|$)/i,
  /^windows-(?:landing|site|shop|company|promo)/i,
  /(?:^|-)(?:plastic|pvc)-windows?(?:-|$)/i,
  /(?:^|-)okna(?:-|$)/i,
  /(?:^|-)fachwerk(?:-|$)/i,
  /(?:^|-)timber-house(?:-|$)/i,
  /(?:^|-)real-estate(?:-|$)/i,
  /(?:^|-)dental(?:-|$)/i,
  /(?:^|-)auto-dealer(?:-|$)/i,
  /(?:^|-)online-store(?:-|$)/i,
  /(?:^|-)ecommerce-site(?:-|$)/i,
  /(?:^|-)law-firm(?:-|$)/i,
  /(?:^|-)restaurant(?:-|$)/i,
  /(?:^|-)crypto-casino(?:-|$)/i,
  /(?:^|-)beauty-salon(?:-|$)/i,
  /(?:^|-)fitness-club(?:-|$)/i,
  /^client-/i,
  /^for-plastic-/i,
];

const NICHE_TEXT_PATTERNS: readonly RegExp[] = [
  /(?:^|[^\p{L}\p{N}_])personal[\s-]+brand(?:s|ing)?(?=$|[^\p{L}\p{N}_])/iu,
  /(?:^|[^\p{L}\p{N}_])(?:личн\p{L}*\s+бренд\p{L}*|персональн\p{L}*\s+бренд\p{L}*)(?=$|[^\p{L}\p{N}_])/iu,
  /(?:^|[^\p{L}\p{N}_])plastic[\s-]+windows?(?=$|[^\p{L}\p{N}_])/iu,
  /(?:^|[^\p{L}\p{N}_])пластиков\p{L}*\s+ок(?:он|на\p{L}*)(?=$|[^\p{L}\p{N}_])/iu,
  /(?:^|[^\p{L}\p{N}_])(?:fachwerk|фахверк\p{L}*)(?=$|[^\p{L}\p{N}_])/iu,
  /(?:^|[^\p{L}\p{N}_])timber[\s-]+house(?=$|[^\p{L}\p{N}_])/iu,
  /(?:^|[^\p{L}\p{N}_])(?:dental[\s-]+clinic|стоматолог\p{L}*)(?=$|[^\p{L}\p{N}_])/iu,
  /(?:^|[^\p{L}\p{N}_])(?:real[\s-]+estate|недвижимост\p{L}*)(?=$|[^\p{L}\p{N}_])/iu,
  /(?:^|[^\p{L}\p{N}_])(?:auto[\s-]+dealer|автосалон\p{L}*|автодилер\p{L}*)(?=$|[^\p{L}\p{N}_])/iu,
  /(?:^|[^\p{L}\p{N}_])(?:online[\s-]+store|ecommerce[\s-]+site|интернет[-\s]+магазин\p{L}*)(?=$|[^\p{L}\p{N}_])/iu,
  /(?:^|[^\p{L}\p{N}_])(?:law[\s-]+firm|юридическ\p{L}*\s+фирм\p{L}*)(?=$|[^\p{L}\p{N}_])/iu,
  /(?:^|[^\p{L}\p{N}_])(?:restaurant|ресторан\p{L}*)(?=$|[^\p{L}\p{N}_])/iu,
  /(?:^|[^\p{L}\p{N}_])(?:crypto[\s-]+casino|крипто[-\s]?казино)(?=$|[^\p{L}\p{N}_])/iu,
  /(?:^|[^\p{L}\p{N}_])(?:beauty[\s-]+salon|салон\p{L}*\s+красоты|fitness[\s-]+club|фитнес[-\s]+клуб\p{L}*)(?=$|[^\p{L}\p{N}_])/iu,
];

const HINT_TO_BROAD: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:websites?|web-design|web|landing|landings?|site|sites|ui-kit|uikit|personal-brand|plastic-windows?|fachwerk|online-store|ecommerce-site)/i, "websites"],
  [/^(?:branding|brand|brandbook|identity|design|logo)/i, "branding"],
  [/^(?:marketing|ads|direct|funnel|funnels|cro|ppc|smm|leadgen|sales|outreach)/i, "marketing"],
  [/^(?:content|copy|copywriting|editorial|articles?|blog|telegram)/i, "content"],
  [/^(?:analytics|analytics-ops|bi|bi-reporting|metrics|data)/i, "analytics"],
  [/^(?:operations|ops|crm|backoffice|support)/i, "operations"],
  [/^(?:media|video|reels|shorts|audio|podcast|photo)/i, "media"],
  [/^(?:seo|cocoon)/i, "seo"],
  [/^(?:research|dossier|factcheck)/i, "research"],
  [/^(?:code|dev|engineering|qa|devops|security|product)/i, "code"],
  [/^(?:business|finance|legal|hr|education|billing|invoice)/i, "business"],
  [/^(?:games?|roblox|blender|3d)/i, "games"],
  [/^(?:routines?|schedule)/i, "routines"],
  [/^(?:service|release)/i, "service"],
];

function emitTaxonomyLog(
  log: ((message: string) => void) | undefined,
  level: "debug" | "warn",
  event: string,
  payload: Record<string, unknown>,
  override?: TaxonomyLogLevel,
): void {
  if (!log) return;
  const envRaw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.LOG_LEVEL?.trim().toLowerCase() as TaxonomyLogLevel | undefined;
  const effective = override ?? (envRaw && envRaw in LOG_RANK ? envRaw : "debug");
  if (LOG_RANK[level] < LOG_RANK[effective]) return;
  log(`${level.toUpperCase()} [nightGraphs.taxonomy] ${event} ${redactKnown(JSON.stringify(payload))}`);
}

function matchFirst(text: string, patterns: readonly RegExp[]): string | null {
  for (const re of patterns) {
    re.lastIndex = 0;
    const hit = re.exec(text);
    if (hit) return hit[0].trim();
  }
  return null;
}

/** Checks whether a category ID belongs to the canonical broad discipline ceiling. */
export function isAllowedBroadCategoryId(id: string): boolean {
  const norm = id.trim().toLowerCase();
  if (!norm || !CATEGORY_SLUG_RE.test(norm)) return false;
  if (norm.split("-").length > 2) return false;
  if (matchFirst(norm, NICHE_SLUG_PATTERNS)) return false;
  return isBuiltinWorkflowCategory(norm) || Object.hasOwn(BROAD_DYNAMIC_CATEGORIES, norm) || EXTRA_BROAD_CATEGORY_IDS.has(norm);
}

/** Maps a broad category ID or niche/discipline hint to a canonical broad category shelf, or `null` when unknown. */
export function canonicalBroadCategory(idOrHint: string): { id: string; label: { en: string; ru: string } } | null {
  const norm = idOrHint.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!norm) return null;
  if (Object.hasOwn(BROAD_DYNAMIC_CATEGORIES, norm)) return { id: norm, label: BROAD_DYNAMIC_CATEGORIES[norm]! };
  if (Object.hasOwn(BUILTIN_CATEGORY_LABELS, norm)) return { id: norm, label: BUILTIN_CATEGORY_LABELS[norm]! };
  for (const [pattern, targetId] of HINT_TO_BROAD) {
    if (pattern.test(norm)) {
      const label = BROAD_DYNAMIC_CATEGORIES[targetId] ?? BUILTIN_CATEGORY_LABELS[targetId];
      return label ? { id: targetId, label } : null;
    }
  }
  return null;
}

function localizedEntries(value: unknown, basePath: string): Array<{ path: string; text: string }> {
  if (typeof value === "string") return value.trim() ? [{ path: basePath, text: value.trim() }] : [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const out: Array<{ path: string; text: string }> = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim()) out.push({ path: `${basePath}.${k}`, text: v.trim() });
  }
  return out;
}

/** Validates that a workflow's category shelf and identity (id/name) remain broadly reusable rather than client/vertical-bound. */
export function validateCategoryAndIdentityGeneralization(
  definition: Record<string, unknown>,
  options?: { log?: (message: string) => void; logLevel?: TaxonomyLogLevel },
): TaxonomyViolation[] {
  const workflowId = typeof definition.id === "string" && definition.id.trim() ? definition.id.trim() : "unknown";
  const violations: TaxonomyViolation[] = [];
  let categoryId: string | null = null;

  const pushViolation = (code: TaxonomyViolation["code"], path: string, detail: string, matchedToken: string) => {
    violations.push({ code, path, detail, matchedToken });
    emitTaxonomyLog(options?.log, "warn", "niche_rejected", { workflowId, categoryId, code, matchedToken }, options?.logLevel);
  };

  if (definition.category !== undefined && definition.category !== null) {
    if (typeof definition.category === "string") {
      categoryId = definition.category.trim();
      if (categoryId && !isAllowedBroadCategoryId(categoryId)) {
        const niche = matchFirst(categoryId, NICHE_SLUG_PATTERNS) ?? categoryId;
        pushViolation("niche_category_violation", "category", `Category "${categoryId}" is outside the broad discipline taxonomy`, niche);
      }
    } else if (typeof definition.category === "object" && !Array.isArray(definition.category)) {
      const cat = definition.category as Record<string, unknown>;
      categoryId = typeof cat.id === "string" ? cat.id.trim() : "";
      if (categoryId && !isAllowedBroadCategoryId(categoryId)) {
        const niche = matchFirst(categoryId, NICHE_SLUG_PATTERNS) ?? categoryId;
        pushViolation("niche_category_violation", "category.id", `Category "${categoryId}" is outside the broad discipline taxonomy`, niche);
      }
      for (const entry of localizedEntries(cat.label, "category.label")) {
        const hit = matchFirst(entry.text, NICHE_TEXT_PATTERNS);
        if (hit) {
          pushViolation("niche_category_violation", entry.path, `Category label "${entry.text}" encodes a narrow vertical/niche`, hit);
        }
      }
    }
  }

  if (typeof definition.id === "string" && definition.id.trim()) {
    const slugHit = matchFirst(definition.id.trim(), NICHE_SLUG_PATTERNS);
    if (slugHit) {
      pushViolation("niche_workflow_identity", "id", `Workflow id "${definition.id.trim()}" encodes a narrow client vertical/persona`, slugHit);
    }
  }

  for (const entry of localizedEntries(definition.name, "name")) {
    const textHit = matchFirst(entry.text, NICHE_TEXT_PATTERNS);
    if (textHit) {
      pushViolation("niche_workflow_identity", entry.path, `Workflow name "${entry.text}" encodes a narrow client vertical/persona`, textHit);
    }
  }

  if (violations.length === 0) {
    emitTaxonomyLog(options?.log, "debug", "category_checked", {
      workflowId,
      categoryId,
      builtinCount: WORKFLOW_CATEGORIES.length,
    }, options?.logLevel);
  }

  return violations;
}
