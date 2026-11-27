import type { RunRecord, Workflow, WorkflowRunFactSummary } from "@lane-pilot/workflow-engine";
import { isOffered, needsLiveTrial } from "@lane-pilot/workflow-engine";
import { graphCategoryLabel, workKindOf, type WorkKind } from "@lane-pilot/contracts";
import { compareWorkflowCategories, extractCategoryLabel, workflowCategory } from "./categories";

export type PmCatalogRunFacts = WorkflowRunFactSummary | { runs: number; workDone: number; failed: number; lastRunAt: number | null };
export type PmCatalogGraph = {
  id: string;
  name: string;
  description: string;
  kind: WorkKind;
  not_for: string[];
  notYetRunLive?: true;
  runFacts?: PmCatalogRunFacts;
};
export type PmCatalogCategory = {
  id: string;
  label: string;
  graphs: PmCatalogGraph[];
};

/** Groups offered graphs by category for the PM to choose from, with description, `not_for`, and Task 26 run facts when present. */
export function buildPmCatalog(
  workflows: readonly Workflow[],
  options: { stats?: ReadonlyMap<string, RunRecord>; facts?: ReadonlyMap<string, WorkflowRunFactSummary>; locale?: "en" | "ru" } = {},
): PmCatalogCategory[] {
  const locale = options.locale ?? "en";
  const byCategory = new Map<string, { customLabel: { en: string; ru: string } | null; graphs: PmCatalogGraph[] }>();
  for (const wf of workflows) {
    if (!isOffered(wf)) continue;
    const catId = workflowCategory(wf);
    const customLabel = extractCategoryLabel(wf.category);
    let bucket = byCategory.get(catId);
    if (!bucket) {
      bucket = { customLabel, graphs: [] };
      byCategory.set(catId, bucket);
    } else if (!bucket.customLabel && customLabel) {
      bucket.customLabel = customLabel;
    }
    const fact = options.facts?.get(wf.id);
    const stat = options.stats?.get(wf.id);
    const statRuns = stat ? stat.executed + stat.refused + stat.escalated + stat.failed : 0;
    const runFacts: PmCatalogRunFacts | undefined = fact ?? (stat && statRuns > 0
      ? { runs: statRuns, workDone: stat.workDone, failed: stat.failed, lastRunAt: stat.lastRunAt }
      : undefined);
    bucket.graphs.push({
      id: wf.id,
      name: wf.name[locale] || wf.name.en || wf.id,
      description: wf.description[locale] || wf.description.en,
      kind: workKindOf(wf.kind),
      not_for: wf.not_for,
      ...(needsLiveTrial(wf) ? { notYetRunLive: true } : {}),
      ...(runFacts ? { runFacts } : {}),
    });
  }
  return [...byCategory.entries()]
    .sort(([a], [b]) => compareWorkflowCategories(a, b))
    .map(([id, bucket]) => ({
      id,
      label: bucket.customLabel?.[locale] ?? graphCategoryLabel(id, locale) ?? id,
      graphs: bucket.graphs.sort((a, b) => a.id.localeCompare(b.id)),
    }));
}
