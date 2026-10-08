import { presetSelection, presetSlug } from "../workflow/model-presets";

/**
 * Which model a generic workflow agent step runs on. ONE function answers it for the executor (what is spawned) and for the Models
 * view (what the card says), so the two cannot drift. The first level that offers a complete provider + model pair is the step's
 * base; the node's own `provider` / `model` / `reasoning` then override that base field by field. Above all of it sits the owner's
 * OVERRIDE of the step, `workflow.model_override.<workflowId>/<nodeId>` (the project's own settings row, else the global one), so a
 * step of a built-in workflow can run on another model without a copy of the workflow:
 *
 *  0. the override (provider + model; the effort and fast mode as the picker gave them);
 *  1. the node's `model_preset` (a named setting `workflow.preset.<name>.*`, else the built-in default of that preset);
 *  2. the role's stage selection in project settings: analyst and pm-reader on `pm_read`, planner and plan-critic on `plan_critique`,
 *     code-critic on `code_critique`, auditor on `code_critique` then `night_review`, debugger on `workflow.debugger` then `specialist`,
 *     `specialist:<x>` on `specialist` (only the stage's own keys; the writer's profile is not borrowed);
 *  3. the generic `workflow.agent.*` selection for agent steps;
 *  4. the model the PM chat runs on;
 *  5. the last resort below, when not even the PM's model is known.
 *
 * The architect and the router are not generic agent steps and do not come through here.
 */
export const DEFAULT_PROVIDER = "claude-code";
export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_REASONING = "high";

export type AgentModelSource = "override" | "node" | "preset" | "stage" | "agent" | "pm" | "role-default";
export type AgentModel = {
  providerId: string; model: string; reasoningEffort: string;
  /** The node's own `service_tier` (fast mode); null when it names none, so the provider's default applies. */
  serviceTier: "default" | "fast" | null;
  source: AgentModelSource;
  /** The preset name, or the setting key the value comes from; null for the node's own fields, the PM and the last resort. */
  sourceKey: string | null;
  /** True when the node itself names no provider, model or reasoning. */
  inherited: boolean;
  issues: string[];
};
export type AgentModelInput = {
  role: string;
  node: { provider?: string | null; model?: string | null; reasoning?: string | null; service_tier?: string | null; model_preset?: string | null };
  settings: Record<string, unknown>;
  pm: { providerId: string; model: string } | null;
  /** The workflow and node the step belongs to: the key of an override. Without them no override applies. */
  at?: { workflowId: string; nodeId: string };
  /**
   * Whether the machine the step will run on offers a provider/model: true, false, or null/undefined when that is not known (then it is available).
   * A preset, a stage or the generic selection whose model it does not offer is passed over for the next level (`preset_unavailable` /
   * `selection_unavailable`); a model the step itself names (its fields, an override) is kept and flagged `model_unavailable_here`.
   */
  offered?: (providerId: string, model: string) => boolean | null | undefined;
};

export const MODEL_OVERRIDE_PREFIX = "workflow.model_override.";
export const modelOverrideKey = (workflowId: string, nodeId: string): string => `${MODEL_OVERRIDE_PREFIX}${workflowId}/${nodeId}`;
export type ModelOverride = { provider: string; model: string; reasoning_effort?: string; service_tier?: "fast" | "default" };

/** The override stored under `key` when it is a complete pair; anything else is no override. */
export function modelOverrideAt(settings: Record<string, unknown>, key: string): ModelOverride | null {
  const raw = settings[key];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const provider = text(row.provider), model = text(row.model), effort = text(row.reasoning_effort), tier = text(row.service_tier);
  if (!provider || !model) return null;
  return { provider, model, ...(effort ? { reasoning_effort: effort } : {}), ...(tier === "fast" || tier === "default" ? { service_tier: tier } : {}) };
}

/** The settings prefixes of the stages a role borrows its model from, in order, with the effort the stage runs on when it sets none. */
const ROLE_STAGES: Record<string, string[]> = {
  analyst: ["pm_read"], "pm-reader": ["pm_read"], planner: ["plan_critique"], "plan-critic": ["plan_critique"], "code-critic": ["code_critique"],
  auditor: ["code_critique", "night_review"], debugger: ["workflow.debugger", "specialist"],
};
const STAGE_EFFORT: Record<string, string> = { pm_read: "low", plan_critique: "medium", code_critique: "medium", night_review: "high", specialist: "high" };
export const roleStages = (role: string): string[] => (role.startsWith("specialist:") ? ["specialist"] : ROLE_STAGES[role] ?? []);

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

type Level = { providerId: string; model: string; effort: string | null; source: AgentModelSource; sourceKey: string | null };

/** A complete pair under `<prefix>.provider` and `<prefix>.model`; a half-set pair is not a selection and is reported. */
function pairAt(settings: Record<string, unknown>, prefix: string, issues: string[]): { providerId: string; model: string; effort: string | null } | null {
  const providerId = text(settings[`${prefix}.provider`]), model = text(settings[`${prefix}.model`]);
  if (providerId && model) return { providerId, model, effort: text(settings[`${prefix}.reasoning_effort`]) };
  if (providerId || model) issues.push("incomplete_selection");
  return null;
}

export function resolveAgentModel(input: AgentModelInput): AgentModel {
  const { node, settings } = input;
  const issues: string[] = [];
  const own = { provider: text(node.provider), model: text(node.model), reasoning: text(node.reasoning) };
  const presetName = text(node.model_preset);
  let level: Level | null = null;

  const here = (providerId: string, model: string) => input.offered?.(providerId, model) !== false;
  if (presetName) {
    const slug = presetSlug(presetName);
    const preset = slug ? presetSelection(slug, settings) : null;
    if (preset && !here(preset.providerId, preset.model)) issues.push("preset_unavailable");
    else if (preset) level = { providerId: preset.providerId, model: preset.model, effort: preset.reasoning, source: "preset", sourceKey: presetName };
    else issues.push("unknown_preset");
  }
  for (const stage of level ? [] : roleStages(input.role)) {
    const found = pairAt(settings, stage, issues);
    if (found && !here(found.providerId, found.model)) { issues.push("selection_unavailable"); continue; }
    if (found) { level = { ...found, effort: found.effort ?? STAGE_EFFORT[stage] ?? null, source: "stage", sourceKey: `${stage}.model` }; break; }
  }
  if (!level) {
    const found = pairAt(settings, "workflow.agent", issues);
    if (found && !here(found.providerId, found.model)) issues.push("selection_unavailable");
    else if (found) level = { ...found, source: "agent", sourceKey: "workflow.agent.model" };
  }
  if (!level && input.pm) level = { providerId: input.pm.providerId, model: input.pm.model, effort: null, source: "pm", sourceKey: null };
  level ??= { providerId: DEFAULT_PROVIDER, model: DEFAULT_MODEL, effort: null, source: "role-default", sourceKey: null };

  const key = input.at ? modelOverrideKey(input.at.workflowId, input.at.nodeId) : null;
  const override = key ? modelOverrideAt(settings, key) : null;
  if (override) {
    return {
      providerId: override.provider, model: override.model, reasoningEffort: override.reasoning_effort ?? own.reasoning ?? level.effort ?? DEFAULT_REASONING,
      serviceTier: override.service_tier ?? null, source: "override", sourceKey: key, inherited: false,
      issues: here(override.provider, override.model) ? issues : [...issues, "model_unavailable_here"],
    };
  }
  if (own.provider && !own.model) issues.push("provider_without_model");
  const tier = text(node.service_tier);
  const set = Boolean(own.provider || own.model || own.reasoning || tier);
  // The step's own pair is its choice: it is kept, and said not to run here.
  if (set && (own.provider || own.model) && !here(own.provider ?? level.providerId, own.model ?? level.model)) issues.push("model_unavailable_here");
  return {
    providerId: own.provider ?? level.providerId, model: own.model ?? level.model, reasoningEffort: own.reasoning ?? level.effort ?? DEFAULT_REASONING,
    serviceTier: tier === "fast" || tier === "default" ? tier : null,
    source: set ? "node" : level.source, sourceKey: set ? null : level.sourceKey, inherited: !set, issues,
  };
}
