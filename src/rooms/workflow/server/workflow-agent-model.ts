import { belowTier, modelTier, resolveRoleModel, roleDefaultModel, roleRow, ROLE_TABLE, type ModelTier } from "@lane-pilot/models";

/**
 * Which model a generic workflow agent step runs on. ONE function answers it for the executor (what is spawned) and for the Models
 * view (what the card says), so the two cannot drift.
 *
 * The model belongs to the ROLE, not to the step (packages/models/src/role-models.ts): one table «role -> model», the same in every graph.
 * The step's role picks the row; the row is the owner's pick in Settings (`role_model.<role>`), else a stage selection the owner set
 * earlier for that role, else the built-in default of the table. Nothing on the node, no per-step override, no preset and no generic
 * `workflow.agent.*` selection takes part (settings rows of those keys are ignored).
 *
 * Two callers may pin a model for ONE run of an agent, and only they: a scheduled agent that names its own model, and an agent the owner
 * created that names its own model (`pinned`). Everything else is the table.
 *
 * When the machine the helpers run on does not offer the table's model, the role's built-in default is tried, then the PM chat's model
 * (which that machine runs by definition); the issue `selection_unavailable` says so. The architect and the router are not generic agent
 * steps and do not come through here (the architect reads its own row of the table).
 */
export const DEFAULT_PROVIDER = "claude-code";
export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_REASONING = "high";

export type AgentModelSource = "table" | "stage" | "role-default" | "pm" | "pinned";
export type AgentModel = {
  providerId: string; model: string; reasoningEffort: string;
  /** The pinned run's service tier (fast mode); null otherwise, so the provider's default applies. */
  serviceTier: "default" | "fast" | null;
  source: AgentModelSource;
  /** The setting key the value comes from; null for the built-in default, the PM and a pinned run. */
  sourceKey: string | null;
  /** True unless the run pinned its own model. */
  inherited: boolean;
  issues: string[];
};
export type AgentModelInput = {
  role: string;
  /** The model a scheduled agent or an owner-created agent names for itself; the table is not consulted for the fields it sets. */
  pinned?: { provider?: string | null; model?: string | null; reasoning?: string | null; service_tier?: string | null } | undefined;
  settings: Record<string, unknown>;
  pm: { providerId: string; model: string } | null;
  /**
   * Whether the machine the step will run on offers a provider/model: true, false, or null/undefined when that is not known (then it is available).
   * A table model it does not offer is passed over for the next candidate; a pinned model is kept and flagged `model_unavailable_here`.
   */
  offered?: (providerId: string, model: string) => boolean | null | undefined;
};

/**
 * The least a deciding role needs, from the table. A model this role inherited (a stage selection) that is below it is replaced by the role's
 * default (`escalated_for_role`); the owner's own pick in the table is kept and marked `light_model_for_role`.
 */
export const ROLE_LEAST_TIER: Record<string, ModelTier> = Object.fromEntries(ROLE_TABLE.flatMap((row) => (row.least ? [[row.id, row.least]] : [])));

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

export function resolveAgentModel(input: AgentModelInput): AgentModel {
  const issues: string[] = [];
  const here = (providerId: string, model: string) => input.offered?.(providerId, model) !== false;
  const row = roleRow(input.role);
  const least = ROLE_LEAST_TIER[row.id];
  const pin = input.pinned;
  const pinnedModel = text(pin?.model);
  const pinnedTier = text(pin?.service_tier);
  const serviceTier: "default" | "fast" | null = pinnedTier === "fast" || pinnedTier === "default" ? pinnedTier : null;

  const chosen = resolveRoleModel(input.role, input.settings);
  if (chosen.escalated) issues.push("escalated_for_role");
  if (pinnedModel) {
    const providerId = text(pin?.provider) ?? DEFAULT_PROVIDER;
    if (least && belowTier(modelTier(pinnedModel), least)) issues.push("light_model_for_role");
    if (!here(providerId, pinnedModel)) issues.push("model_unavailable_here");
    return { providerId, model: pinnedModel, reasoningEffort: text(pin?.reasoning) ?? chosen.effort, serviceTier, source: "pinned", sourceKey: null, inherited: false, issues };
  }

  const effort = text(pin?.reasoning) ?? chosen.effort;
  if (chosen.source === "table" && least && belowTier(modelTier(chosen.model), least)) issues.push("light_model_for_role");
  const base = { reasoningEffort: effort, serviceTier, inherited: !text(pin?.reasoning) };
  if (here(chosen.providerId, chosen.model)) return { providerId: chosen.providerId, model: chosen.model, ...base, source: chosen.source === "default" ? "role-default" : chosen.source, sourceKey: chosen.sourceKey, issues };
  issues.push("selection_unavailable");
  const builtin = roleDefaultModel(row.id);
  if ((builtin.model !== chosen.model || builtin.providerId !== chosen.providerId) && here(builtin.providerId, builtin.model)) {
    return { providerId: builtin.providerId, model: builtin.model, ...base, reasoningEffort: text(pin?.reasoning) ?? builtin.effort, source: "role-default", sourceKey: null, issues };
  }
  // The PM chat runs on this machine by definition: its model is never judged against the catalog.
  if (input.pm) return { providerId: input.pm.providerId, model: input.pm.model, ...base, reasoningEffort: text(pin?.reasoning) ?? DEFAULT_REASONING, source: "pm", sourceKey: null, issues };
  // Nothing on offer is known to run here: keep the table's model and say so; the executor stops with the machines that do have it.
  issues.push("model_unavailable_here");
  return { providerId: chosen.providerId, model: chosen.model, ...base, source: chosen.source === "default" ? "role-default" : chosen.source, sourceKey: chosen.sourceKey, issues };
}
