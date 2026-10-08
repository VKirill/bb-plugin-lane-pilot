import type { I18nKey } from "../../i18n";

/** The same six tabs at every level: the system defaults, a project and a section of a project. */
export const TAB_IDS = ["overview", "team", "work", "knowledge", "automation", "runs"] as const;
export type TabId = (typeof TAB_IDS)[number];

export const TAB_LABELS: Record<TabId, I18nKey> = {
  overview: "tabOverview",
  team: "tabTeam",
  work: "tabWork",
  knowledge: "tabKnowledge",
  automation: "tabAutomation",
  runs: "tabRuns",
};

/** Tabs the Basic/Advanced switch applies to. */
export const DEPTH_TABS = new Set<TabId>(["team", "work", "knowledge", "automation"]);

/** The parts of a tab that switch inside it (a segment control under the tab bar). */
export const SEGMENTS = {
  knowledge: ["memory", "docs", "rules", "anamnesis"],
  automation: ["workflows", "schedule"],
  runs: ["active", "history", "analytics", "council", "service"],
} as const;
export type SegmentedTab = keyof typeof SEGMENTS;
export type SegmentId<T extends SegmentedTab> = (typeof SEGMENTS)[T][number];

export const SEGMENT_LABELS: Record<string, I18nKey> = {
  memory: "segMemory",
  docs: "segDocs",
  rules: "segRules",
  anamnesis: "segAnamnesis",
  workflows: "segWorkflows",
  schedule: "segSchedule",
  active: "segActive",
  history: "segHistory",
  analytics: "segAnalytics",
  council: "segCouncil",
  service: "segService",
};

/** Where a pre-regroup tab id lives now. Old links, tests and the owner's habits keep working. */
export const LEGACY_TABS: Record<string, { tab: TabId; segment?: string }> = {
  settings: { tab: "work" },
  checks: { tab: "work" },
  council: { tab: "team" },
  access: { tab: "team" },
  memory: { tab: "knowledge", segment: "memory" },
  rules: { tab: "knowledge", segment: "rules" },
  anamnesis: { tab: "knowledge", segment: "anamnesis" },
  workflows: { tab: "automation", segment: "workflows" },
  schedule: { tab: "automation", segment: "schedule" },
  monitor: { tab: "runs", segment: "active" },
  service: { tab: "runs", segment: "service" },
};

export function resolveTab(id: string): { tab: TabId; segment?: string } {
  if ((TAB_IDS as readonly string[]).includes(id)) return { tab: id as TabId };
  return LEGACY_TABS[id] ?? { tab: "overview" };
}

/** The segments a level offers: rules need a project, the anamnesis belongs to the system level. */
export function segmentsFor(tab: SegmentedTab, level: "system" | "project" | "section"): string[] {
  const all: readonly string[] = SEGMENTS[tab];
  if (tab !== "knowledge") return [...all];
  return all.filter((id) => (id === "anamnesis" ? level === "system" : id === "rules" ? level !== "system" : true));
}
