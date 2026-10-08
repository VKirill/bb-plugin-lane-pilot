import type { DraftOp } from "../draft";
import { findModel, findProvider, nodeEffortsFor, validateChoice, type CatalogModel, type ChoiceError, type ModelCatalog } from "@lane-pilot/models";
import { isRaw, nodeById, setNodeOps, type Raw } from "./workflow-edit-model";

/**
 * The draft patches the model pickers write. A step names its model with the `provider`, `model` and `reasoning` fields of the
 * node, and `service_tier` for fast mode (the body of a parallel keeps them inside `child`); clearing them all hands the step back to its default. A combination the
 * catalog does not support never becomes a patch: it comes back as a reason.
 */
export type ModelChoice = { providerId: string; model: string; effort?: string | null; serviceTier?: string | null };
export type ChoiceResult = { ok: true; ops: DraftOp[] } | { ok: false; code: ChoiceError | "no_node" | "no_effort"; detail: string };

const CHILD = /^(.+):child$/;

/** Sets or clears (`null`) the three fields on the node `nodeId`, or on the `child` of the parallel `x` for `x:child`. */
export type ModelFields = { provider: string | null; model: string | null; reasoning: string | null; service_tier?: string | null };
export function modelFieldsOps(definition: Raw, nodeId: string, fields: ModelFields): DraftOp[] | null {
  const body = CHILD.exec(nodeId);
  if (!body) return nodeById(definition, nodeId) ? setNodeOps(nodeId, fields) : null;
  const parent = nodeById(definition, body[1]!);
  if (!parent || !isRaw(parent.child)) return null;
  const child: Raw = { ...parent.child };
  for (const [key, value] of Object.entries(fields)) { if (value === null) delete child[key]; else child[key] = value; }
  return setNodeOps(body[1]!, { child });
}

export const clearModelOps = (definition: Raw, nodeId: string): DraftOp[] | null => modelFieldsOps(definition, nodeId, { provider: null, model: null, reasoning: null, service_tier: null });

/** Why a node cannot be given this choice, or null: the catalog must offer the provider, the model and the effort, and the node schema must know the effort. */
export function choiceRefusal(catalog: ModelCatalog, choice: ModelChoice): Extract<ChoiceResult, { ok: false }> | null {
  const verdict = validateChoice(catalog, choice);
  if (!verdict.ok) return verdict;
  const model = findModel(findProvider(catalog, choice.providerId), choice.model)!;
  return choice.effort && !nodeEffortsFor(model).includes(choice.effort) ? { ok: false, code: "no_effort", detail: `${model.model}: ${choice.effort}` } : null;
}

/** The patch for a choice, after the catalog has agreed to it. */
export function choiceOps(definition: Raw, catalog: ModelCatalog, nodeId: string, choice: ModelChoice): ChoiceResult {
  const refused = choiceRefusal(catalog, choice);
  if (refused) return refused;
  const model = findModel(findProvider(catalog, choice.providerId), choice.model)!;
  const effort = choice.effort ?? null;
  // Fast mode is written only when the choice speaks of it (the native picker always does, so switching provider clears an old one).
  const tier = choice.serviceTier === undefined ? {} : { service_tier: choice.serviceTier === "fast" ? "fast" : null };
  const ops = modelFieldsOps(definition, nodeId, { provider: choice.providerId, model: model.id, reasoning: effort, ...tier });
  return ops ? { ok: true, ops } : { ok: false, code: "no_node", detail: nodeId };
}

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
