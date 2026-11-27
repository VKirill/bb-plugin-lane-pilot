export interface GraphCategoryDef {
  readonly id: string;
  readonly label: { readonly en: string; readonly ru: string };
}

/**
 * The one home of shipped workflow graph categories (id + bilingual label).
 * Adding a category is a single entry here; schema checks, UI shelves, map colors, and the PM catalog derive from it.
 */
export const GRAPH_CATEGORIES = [
  { id: "seo", label: { en: "SEO", ru: "SEO" } },
  { id: "marketing", label: { en: "Marketing", ru: "Маркетинг" } },
  { id: "code", label: { en: "Code and tasks", ru: "Код и задачи" } },
  { id: "planning", label: { en: "Planning and specs", ru: "Планирование и спеки" } },
  { id: "qa", label: { en: "QA and verification", ru: "Проверка и QA" } },
  { id: "ops", label: { en: "Release and ops", ru: "Релиз и операции" } },
  { id: "docs", label: { en: "Documentation", ru: "Документация" } },
  { id: "content", label: { en: "Content and posts", ru: "Контент и посты" } },
  { id: "research", label: { en: "Research", ru: "Исследования" } },
  { id: "games", label: { en: "3D and games", ru: "3D и игры" } },
  { id: "business", label: { en: "Business and documents", ru: "Бизнес и документы" } },
  { id: "routines", label: { en: "Routines and schedules", ru: "Рутины и расписания" } },
  { id: "service", label: { en: "Service", ru: "Служебные" } },
] as const satisfies readonly GraphCategoryDef[];

export type GraphCategoryId = (typeof GRAPH_CATEGORIES)[number]["id"];

export const GRAPH_CATEGORY_IDS = GRAPH_CATEGORIES.map((entry) => entry.id) as unknown as readonly [
  GraphCategoryId,
  ...GraphCategoryId[],
];

/** Minimum length for a workflow description before the library loader warns on startup. */
export const MIN_GRAPH_DESCRIPTION_LENGTH = 50;

const GRAPH_CATEGORY_MAP: ReadonlyMap<string, GraphCategoryDef> = new Map(
  GRAPH_CATEGORIES.map((entry) => [entry.id, entry]),
);

export const isKnownGraphCategory = (id: string): id is GraphCategoryId => GRAPH_CATEGORY_MAP.has(id);

export const graphCategoryLabel = (id: string, locale: "en" | "ru" = "en"): string | null => {
  const found = GRAPH_CATEGORY_MAP.get(id);
  return found ? found.label[locale] : null;
};
