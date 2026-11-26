import type { I18nKey } from "@lane-pilot/i18n";

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
  knowledge: ["memory", "docs"],
  automation: ["workflows", "schedule"],
  runs: ["board", "analytics", "service"],
} as const;
export type SegmentedTab = keyof typeof SEGMENTS;
export type SegmentId<T extends SegmentedTab> = (typeof SEGMENTS)[T][number];

export const SEGMENT_LABELS: Record<string, I18nKey> = {
  memory: "segMemory",
  docs: "segDocs",
  workflows: "segWorkflows",
  schedule: "segSchedule",
  board: "segBoard",
  analytics: "segAnalytics",
  service: "segService",
};

/** Where a pre-regroup tab id lives now. Old links, tests and the owner's habits keep working. */
export const LEGACY_TABS: Record<string, { tab: TabId; segment?: string }> = {
  settings: { tab: "work" },
  checks: { tab: "work" },
  access: { tab: "team" },
  memory: { tab: "knowledge", segment: "memory" },
  workflows: { tab: "automation", segment: "workflows" },
  schedule: { tab: "automation", segment: "schedule" },
  monitor: { tab: "runs", segment: "board" },
  service: { tab: "runs", segment: "service" },
};

export function resolveTab(id: string): { tab: TabId; segment?: string } {
  if ((TAB_IDS as readonly string[]).includes(id)) return { tab: id as TabId };
  return LEGACY_TABS[id] ?? { tab: "overview" };
}

/** The segments of a segmented tab. */
export function segmentsFor(tab: SegmentedTab, _level?: "system" | "project" | "section"): string[] {
  return [...SEGMENTS[tab]];
}
