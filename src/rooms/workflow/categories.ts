/**
 * The shelf a workflow stands on in the library, the map and the export: derived from its id and tags, never stored, so a new graph
 * lands on a shelf by itself. Order matters: the first rule that matches wins (seo-page is SEO, not content; invoice-send is business, not a Telegram post).
 */
export const WORKFLOW_CATEGORIES = ["seo", "marketing", "code", "content", "research", "games", "business", "routines", "service"] as const;
export type WorkflowCategory = (typeof WORKFLOW_CATEGORIES)[number];

const RULES: ReadonlyArray<[WorkflowCategory, (id: string, tags: ReadonlySet<string>) => boolean]> = [
  ["service", (id, tags) => id.startsWith("lp.") || id.startsWith("lp-") || id.startsWith("sp-") || id.startsWith("sp.") || tags.has("lead")],
  ["seo", (id, tags) => id.startsWith("seo-") || tags.has("seo")],
  ["marketing", (id, tags) => id.startsWith("mkt-") || tags.has("marketing")],
  ["games", (_, tags) => ["3d", "blender", "roblox", "game"].some((tag) => tags.has(tag))],
  ["business", (_, tags) => ["finance", "billing", "invoice", "invoices", "elba", "cabinet"].some((tag) => tags.has(tag))],
  ["research", (id, tags) => id.startsWith("ins.") || ["research", "dossier", "factcheck"].some((tag) => tags.has(tag))],
  ["content", (_, tags) => ["content", "social", "video", "telegram", "copywriting", "anamnesis", "digest"].some((tag) => tags.has(tag))],
  ["routines", (_, tags) => ["schedule", "routine", "macos"].some((tag) => tags.has(tag)) && !tags.has("code")],
];

/** Everything that matches no rule is development work: most built-in graphs without tags are code and task flows. */
export function workflowCategory(workflow: { id: string; tags?: readonly string[] }): WorkflowCategory {
  const tags = new Set((workflow.tags ?? []).map((tag) => tag.toLowerCase()));
  return RULES.find(([, test]) => test(workflow.id, tags))?.[0] ?? "code";
}
