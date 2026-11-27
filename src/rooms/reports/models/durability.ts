import type { GraphDriftEntry } from "@lane-pilot/workflow-engine";

export type DurabilitySummary = {
  drifted: GraphDriftEntry[];
  lastExportAt: number | null;
  lastExportDate: string | null;
};

export type DurabilityDeskItem = {
  id: string;
  section: "durability";
  title: string;
  default: "export" | "keep";
  options: readonly ["export", "keep"];
  action: { cli: string; driftedCount: number; workflowIds: string[] };
};

/** Formats a hub-to-git durability section for the weekly review desk (Task 50 §7 / Task 53 §3). */
export function formatDurabilitySection(summary: DurabilitySummary): string {
  const exportedLabel = summary.lastExportDate ?? "never";
  if (summary.drifted.length === 0) {
    return `Durability: all hub graphs match git (last export: ${exportedLabel})`;
  }
  const rows = summary.drifted.map(
    (entry) => `- ${entry.workflowId} v${entry.version} (${entry.status}, hub=${entry.hubSha256.slice(0, 8)})`,
  );
  return [
    `Durability: ${summary.drifted.length} graph(s) out of sync with workflows/ (last export: ${exportedLabel})`,
    ...rows,
    "  run: npm run graphs:export",
  ].join("\n");
}

/** Builds desk items for graphs evolved or published on the hub that differ from `workflows/`. */
export function buildDurabilityDeskItems(summary: DurabilitySummary): DurabilityDeskItem[] {
  if (summary.drifted.length === 0) return [];
  const names = summary.drifted.slice(0, 5).map((d) => `${d.workflowId} v${d.version}`).join(", ");
  const extra = summary.drifted.length > 5 ? ` (+${summary.drifted.length - 5} more)` : "";
  return [
    {
      id: "durability:export",
      section: "durability",
      title: `Export ${summary.drifted.length} hub graph(s) to git: ${names}${extra}`,
      default: "export",
      options: ["export", "keep"],
      action: {
        cli: "npm run graphs:export",
        driftedCount: summary.drifted.length,
        workflowIds: summary.drifted.map((d) => d.workflowId),
      },
    },
  ];
}
