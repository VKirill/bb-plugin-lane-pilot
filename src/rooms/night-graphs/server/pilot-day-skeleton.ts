import { redactKnown } from "@lane-pilot/kit";
import type { PilotDayCategoryHint } from "../../storage";

export type ArtifactSkeleton = {
  deliverableClass: string;
  sections: string[];
  matrices: string[];
  qaChecks: string[];
};

export const ARCHETYPE_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

const CATEGORY_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DELIVERABLE_CLASS_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
const ABS_PATH_RE = /(?:\/Users\/|\/home\/|\/var\/folders\/|\/private\/tmp\/)[^\s"'`)]+|[A-Za-z]:\\[^\s"'`)]+/g;
const PROJ_ID_RE = /\bproj_[a-z0-9_-]{3,}\b/gi;
const HOST_ID_RE = /\bhost_[a-z0-9_-]{3,}\b/gi;
const LITERAL_DOMAIN_RE = /\b(?:[a-z0-9-]+\.)+(?:ru|su|рф|com|net|org|io|ai|app|dev|co|me|info|biz|pro|tech|online|site|store|shop|cloud|uk|de|fr|es|it|nl|pl|ua|by|kz)\b/gi;
const GENERIC_DOMAINS = new Set(["example.com", "example.org", "example.net", "example.ru", "localhost", "127.0.0.1"]);

const LOG_RANK = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;

function shouldLog(level: "debug" | "info" | "warn"): boolean {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (!raw) return true;
  const threshold = raw in LOG_RANK ? LOG_RANK[raw as keyof typeof LOG_RANK] : LOG_RANK.info;
  return LOG_RANK[level] >= threshold;
}

function emitSkeletonLog(
  log: ((msg: string) => void) | undefined,
  level: "debug" | "warn",
  event: string,
  payload: Record<string, unknown>,
): void {
  if (!log || !shouldLog(level)) return;
  log(`${level.toUpperCase()} [nightGraphs.dayDigest] ${event} ${redactKnown(JSON.stringify(payload))}`);
}

export const BROAD_CRAFT_CATEGORIES: Readonly<Record<string, { en: string; ru: string }>> = {
  websites: { en: "Websites & Web Design", ru: "Сайты и веб-дизайн" },
  branding: { en: "Branding & Identity", ru: "Брендинг и айдентика" },
  marketing: { en: "Marketing & Funnels", ru: "Маркетинг и воронки" },
  content: { en: "Content & Editorial", ru: "Контент и редактура" },
  analytics: { en: "Research & Analytics", ru: "Исследования и аналитика" },
  operations: { en: "Operations", ru: "Операционные процессы" },
  seo: { en: "SEO", ru: "SEO" },
  code: { en: "Code", ru: "Код" },
  research: { en: "Research", ru: "Исследования" },
  games: { en: "Games", ru: "Игры" },
  business: { en: "Business", ru: "Бизнес" },
  routines: { en: "Routines", ru: "Регулярное" },
  service: { en: "Service", ru: "Служебные" },
};

const EXACT_VERTICAL_LIFTS: Readonly<Record<string, { parent: string; archetype: string }>> = Object.fromEntries(
  ([
    ["websites", "personal-brand", ["pbs", "personal-brand", "personal-brand-site", "personal-brand-landing", "personal-brand-web"]],
    ["websites", "ecommerce", ["online-store", "ecommerce", "ecommerce-site", "e-commerce", "e-commerce-site", "webstore", "web-store", "internet-shop"]],
    ["websites", "high-ticket-leadgen", ["plastic-windows", "window-site", "windows-site", "windows-landing", "fachwerk-landing", "high-ticket-leadgen", "leadgen-site"]],
    ["websites", "b2b-service", ["b2b-service", "b2b-service-site", "b2b-landing", "agency-site", "consulting-site"]],
    ["websites", "saas-product", ["saas-product", "saas-landing", "saas-site"]],
    ["branding", "brandbook", ["brandbook", "brandbook-design", "brand-book"]],
    ["branding", "brand-identity", ["identity", "visual-identity", "brand-identity"]],
    ["branding", "logo-identity", ["logo-design"]],
    ["branding", "brand-guidelines", ["brand-guidelines"]],
  ] as const).flatMap(([parent, archetype, aliases]) => aliases.map((alias) => [alias, { parent, archetype }] as const)),
);

const toKebab = (raw: string, maxLen: number): string =>
  raw.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, maxLen).replace(/-+$/g, "");

function normalizeArchetypeSlug(raw: unknown, maskFn: (s: string, max: number) => string): string | null {
  if (typeof raw !== "string") return null;
  const masked = maskFn(raw, 64);
  const slug = toKebab(masked, 40);
  if (!slug) return null;
  const aliased = EXACT_VERTICAL_LIFTS[slug]?.archetype ?? slug;
  return ARCHETYPE_SLUG_RE.test(aliased) ? aliased : null;
}

function liftNarrowCategory(id: string): { parent: string; archetype: string | null } | null {
  const exact = EXACT_VERTICAL_LIFTS[id];
  if (exact) return exact;
  if (/(?:^|-)(?:site|sites|landing|landings|web|website|webdesign|ui-kit|uikit|store|shop|pen-design|figma)(?:-|$)/.test(id)) {
    const stripped = id.replace(/-(?:site|sites|landing|landings|web|website)$/, "");
    const archetype = ARCHETYPE_SLUG_RE.test(stripped) ? stripped : ARCHETYPE_SLUG_RE.test(id) ? id : null;
    return { parent: "websites", archetype };
  }
  if (/(?:^|-)(?:brandbook|brand-book|identity|logo|brand-guide|guidelines)(?:-|$)/.test(id)) {
    const stripped = id.replace(/-(?:design)$/, "");
    const archetype = ARCHETYPE_SLUG_RE.test(stripped) ? stripped : ARCHETYPE_SLUG_RE.test(id) ? id : null;
    return { parent: "branding", archetype };
  }
  if (/(?:^|-)(?:funnel|leadgen|ads|direct|cro|campaign)(?:-|$)/.test(id)) {
    return { parent: "marketing", archetype: ARCHETYPE_SLUG_RE.test(id) ? id : null };
  }
  if (/(?:^|-)(?:copywriting|editorial|blog|article|newsletter)(?:-|$)/.test(id)) {
    return { parent: "content", archetype: ARCHETYPE_SLUG_RE.test(id) ? id : null };
  }
  if (/(?:^|-)(?:analytics|audit|competitor|teardown)(?:-|$)/.test(id)) {
    return { parent: "analytics", archetype: ARCHETYPE_SLUG_RE.test(id) ? id : null };
  }
  if (/(?:^|-)(?:ops|operations|devops|deploy|infra)(?:-|$)/.test(id)) {
    return { parent: "operations", archetype: ARCHETYPE_SLUG_RE.test(id) ? id : null };
  }
  return null;
}

/**
 * Separates broad craft discipline (`categoryHint`) from vertical/subtype (`archetypeHint`),
 * automatically lifting narrow niche slugs placed into `category_hint` to their parent discipline.
 */
export function normalizeCategoryAndArchetype(
  rawCategoryHint: unknown,
  rawArchetypeHint: unknown,
  maskFn: (s: string, max: number) => string,
  log?: (msg: string) => void,
): { categoryHint: PilotDayCategoryHint | null; archetypeHint: string | null } {
  const explicitArchetype = normalizeArchetypeSlug(rawArchetypeHint, maskFn);
  if (!rawCategoryHint || typeof rawCategoryHint !== "object" || Array.isArray(rawCategoryHint)) {
    return { categoryHint: null, archetypeHint: explicitArchetype };
  }
  const rec = rawCategoryHint as { id?: unknown; label?: { en?: unknown; ru?: unknown } };
  if (typeof rec.id !== "string") return { categoryHint: null, archetypeHint: explicitArchetype };
  const id = toKebab(rec.id, 32);
  if (!CATEGORY_ID_RE.test(id)) return { categoryHint: null, archetypeHint: explicitArchetype };

  let label: { en: string; ru: string } | undefined;
  if (rec.label && typeof rec.label === "object" && !Array.isArray(rec.label)) {
    const en = maskFn(typeof rec.label.en === "string" ? rec.label.en : "", 80);
    const ru = maskFn(typeof rec.label.ru === "string" ? rec.label.ru : "", 80);
    if (en || ru) label = { en: en || ru, ru: ru || en };
  }

  if (id in BROAD_CRAFT_CATEGORIES) {
    return { categoryHint: label ? { id, label } : { id }, archetypeHint: explicitArchetype };
  }

  const lifted = liftNarrowCategory(id);
  if (lifted) {
    const archetypeHint = explicitArchetype ?? lifted.archetype;
    emitSkeletonLog(log, "debug", "category_lifted", { from: id, to: lifted.parent, archetypeHint });
    return {
      categoryHint: { id: lifted.parent, label: BROAD_CRAFT_CATEGORIES[lifted.parent]! },
      archetypeHint,
    };
  }

  return { categoryHint: label ? { id, label } : { id }, archetypeHint: explicitArchetype };
}

function sanitizeSkeletonText(raw: string, maskFn: (s: string, max: number) => string, maxLen: number): string {
  const masked = redactKnown(maskFn(raw, maxLen * 2));
  const stripped = masked
    .replace(ABS_PATH_RE, "[path]")
    .replace(PROJ_ID_RE, "[project]")
    .replace(HOST_ID_RE, "[host]")
    .replace(LITERAL_DOMAIN_RE, (match) => {
      const dom = match.toLowerCase();
      return GENERIC_DOMAINS.has(dom) || dom.endsWith(".example") || dom.endsWith(".localhost") ? match : "[domain]";
    })
    .replace(/\s+/g, " ")
    .trim();
  return stripped.slice(0, maxLen).trim();
}

function sanitizeSkeletonList(raw: unknown, maskFn: (s: string, max: number) => string, maxItems: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const clean = sanitizeSkeletonText(item, maskFn, 160);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** Validates, de-projectizes, and normalizes an extracted `artifact_skeleton` payload. */
export function normalizeArtifactSkeleton(
  raw: unknown,
  maskFn: (s: string, max: number) => string,
  options?: { processKey?: string; archetypeHint?: string | null; log?: (msg: string) => void },
): ArtifactSkeleton | null {
  if (raw === null || raw === undefined) return null;
  const ctx = { processKey: options?.processKey ?? null, archetypeHint: options?.archetypeHint ?? null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    emitSkeletonLog(options?.log, "warn", "skeleton_dropped_invalid", { ...ctx, reason: "not_object" });
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const rawClass = rec.deliverable_class ?? rec.deliverableClass;
  const deliverableClass = typeof rawClass === "string"
    ? toKebab(sanitizeSkeletonText(rawClass, maskFn, 64), 48)
    : "";
  if (!DELIVERABLE_CLASS_RE.test(deliverableClass)) {
    emitSkeletonLog(options?.log, "warn", "skeleton_dropped_invalid", { ...ctx, reason: "invalid_deliverable_class" });
    return null;
  }
  const sections = sanitizeSkeletonList(rec.sections, maskFn, 16);
  if (sections.length < 2) {
    emitSkeletonLog(options?.log, "warn", "skeleton_dropped_invalid", { ...ctx, deliverableClass, reason: "insufficient_sections", count: sections.length });
    return null;
  }
  const matrices = sanitizeSkeletonList(rec.matrices ?? rec.required_tables_or_matrices, maskFn, 10);
  const qaChecks = sanitizeSkeletonList(rec.qa_checks ?? rec.qaChecks, maskFn, 12);
  emitSkeletonLog(options?.log, "debug", "skeleton_extracted", {
    ...ctx, deliverableClass, sections: sections.length, matrices: matrices.length, qaChecks: qaChecks.length,
  });
  return { deliverableClass, sections, matrices, qaChecks };
}
