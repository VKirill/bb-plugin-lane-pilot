/**
 * The shelf a workflow stands on in the library, the map and the export: an explicit `category` wins; otherwise derived
 * from its id and tags so every graph lands on a shelf. Order matters: the first rule that matches wins.
 */
export const WORKFLOW_CATEGORIES = ["seo", "marketing", "code", "content", "research", "games", "business", "routines", "service"] as const;
export type BuiltinWorkflowCategory = (typeof WORKFLOW_CATEGORIES)[number];
export type WorkflowCategory = BuiltinWorkflowCategory;

export const isBuiltinWorkflowCategory = (cat: string): cat is BuiltinWorkflowCategory => (WORKFLOW_CATEGORIES as readonly string[]).includes(cat);

const RULES: ReadonlyArray<[BuiltinWorkflowCategory, (id: string, tags: ReadonlySet<string>) => boolean]> = [
  ["service", (id, tags) => id.startsWith("lp.") || id.startsWith("lp-") || id.startsWith("sp-") || id.startsWith("sp.") || tags.has("lead")],
  ["seo", (id, tags) => id.startsWith("seo-") || tags.has("seo")],
  ["marketing", (id, tags) => id.startsWith("mkt-") || tags.has("marketing")],
  ["games", (_, tags) => ["3d", "blender", "roblox", "game"].some((tag) => tags.has(tag))],
  ["business", (_, tags) => ["finance", "billing", "invoice", "invoices", "elba", "cabinet"].some((tag) => tags.has(tag))],
  ["research", (id, tags) => id.startsWith("ins.") || ["research", "dossier", "factcheck"].some((tag) => tags.has(tag))],
  ["content", (_, tags) => ["content", "social", "video", "telegram", "copywriting", "anamnesis", "digest"].some((tag) => tags.has(tag))],
  ["routines", (_, tags) => ["schedule", "routine", "macos"].some((tag) => tags.has(tag)) && !tags.has("code")],
];

type CategoryInput = string | { id: string; label?: { en: string; ru: string } | null } | null;

/** Everything that matches no explicit category or rule is development work: most built-in graphs without tags are code and task flows. */
export function workflowCategory(workflow: { id: string; tags?: readonly string[]; category?: CategoryInput }): WorkflowCategory {
  const explicitId = typeof workflow.category === "string" ? workflow.category.trim() : workflow.category?.id?.trim();
  if (explicitId) return explicitId as WorkflowCategory;
  const tags = new Set((workflow.tags ?? []).map((tag) => tag.toLowerCase()));
  return RULES.find(([, test]) => test(workflow.id, tags))?.[0] ?? "code";
}

export function extractCategoryLabel(category: unknown): { en: string; ru: string } | null {
  if (!category || typeof category !== "object") return null;
  const label = (category as { label?: unknown }).label;
  if (!label || typeof label !== "object") return null;
  const { en, ru } = label as { en?: unknown; ru?: unknown };
  if (typeof en !== "string" || typeof ru !== "string") return null;
  const trimmedEn = en.trim();
  const trimmedRu = ru.trim();
  return trimmedEn && trimmedRu ? { en: trimmedEn, ru: trimmedRu } : null;
}

export function humanizeCategorySlug(slug: string): string {
  const words = slug.trim().replace(/[-_]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : slug;
}

export function resolveCategoryLabel(
  cat: string,
  customLabel: { en: string; ru: string } | null | undefined,
  locale: "en" | "ru",
  translateBuiltin: (cat: BuiltinWorkflowCategory) => string,
): string {
  if (isBuiltinWorkflowCategory(cat) && !customLabel) return translateBuiltin(cat);
  return customLabel?.[locale]?.trim() || customLabel?.en?.trim() || customLabel?.ru?.trim()
    || (isBuiltinWorkflowCategory(cat) ? translateBuiltin(cat) : humanizeCategorySlug(cat));
}

export function compareWorkflowCategories(a: string, b: string, runsA = 0, runsB = 0): number {
  const serviceDiff = Number(a === "service") - Number(b === "service");
  if (serviceDiff !== 0) return serviceDiff;
  if (runsA !== runsB) return runsB - runsA;
  const idxA = WORKFLOW_CATEGORIES.indexOf(a as BuiltinWorkflowCategory);
  const idxB = WORKFLOW_CATEGORIES.indexOf(b as BuiltinWorkflowCategory);
  if (idxA >= 0 && idxB >= 0) return idxA - idxB;
  if (idxA >= 0) return -1;
  if (idxB >= 0) return 1;
  return a.localeCompare(b);
}
