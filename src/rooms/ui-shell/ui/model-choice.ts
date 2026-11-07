import { findProvider, nodeEffortsFor, type CatalogModel, type ModelCatalog } from "@lane-pilot/models";

/**
 * What BB's native model picker answers with (the schedule's pickers use it; a graph's steps do not: their model is the role's, set in
 * the table «role -> model» in Settings, and no draft patch writes a model onto a node any more).
 */
export type ModelChoice = { providerId: string; model: string; effort?: string | null; serviceTier?: string | null };

/** An effort to keep when the model changes: the current one if the new model has it, else the model's own default, else none. */
export function effortFor(model: CatalogModel | undefined, current: string | null): string | null {
  const allowed = nodeEffortsFor(model);
  if (current && allowed.includes(current)) return current;
  return model?.defaultEffort && allowed.includes(model.defaultEffort) ? model.defaultEffort : null;
}

/** What choosing a provider selects: its first model that some machine has, with an effort that model and the node both know. */
export function firstChoice(catalog: ModelCatalog, providerId: string, currentEffort: string | null): ModelChoice | null {
  const provider = findProvider(catalog, providerId);
  const offered = provider?.models.filter((row) => row.hostIds.length > 0) ?? [];
  const model = offered.find((row) => row.isDefault) ?? offered[0];
  return provider && provider.hostIds.length && model ? { providerId, model: model.id, effort: effortFor(model, currentEffort) } : null;
}
