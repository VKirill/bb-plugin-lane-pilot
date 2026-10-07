import { presetSelection, presetSlug } from "../workflow/model-presets";

/**
 * Which model a generic workflow agent step runs on. ONE function answers it for the executor (what is spawned) and for the Models
 * view (what the card says), so the two cannot drift. The first level that offers a complete provider + model pair is the step's
 * base; the node's own `provider` / `model` / `reasoning` then override that base field by field:
 *
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

export type AgentModelSource = "node" | "preset" | "stage" | "agent" | "pm" | "role-default";
export type AgentModel = {
  providerId: string; model: string; reasoningEffort: string;
  source: AgentModelSource;
  /** The preset name, or the setting key the value comes from; null for the node's own fields, the PM and the last resort. */
  sourceKey: string | null;
  /** True when the node itself names no provider, model or reasoning. */
  inherited: boolean;
  issues: string[];
};
export type AgentModelInput = {
  role: string;
  node: { provider?: string | null; model?: string | null; reasoning?: string | null; model_preset?: string | null };
  settings: Record<string, unknown>;
  pm: { providerId: string; model: string } | null;
};

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

  if (presetName) {
    const slug = presetSlug(presetName);
    const preset = slug ? presetSelection(slug, settings) : null;
    if (preset) level = { providerId: preset.providerId, model: preset.model, effort: preset.reasoning, source: "preset", sourceKey: presetName };
    else issues.push("unknown_preset");
  }
  for (const stage of level ? [] : roleStages(input.role)) {
    const found = pairAt(settings, stage, issues);
    if (found) { level = { ...found, effort: found.effort ?? STAGE_EFFORT[stage] ?? null, source: "stage", sourceKey: `${stage}.model` }; break; }
  }
  if (!level) {
    const found = pairAt(settings, "workflow.agent", issues);
    if (found) level = { ...found, source: "agent", sourceKey: "workflow.agent.model" };
  }
  if (!level && input.pm) level = { providerId: input.pm.providerId, model: input.pm.model, effort: null, source: "pm", sourceKey: null };
  level ??= { providerId: DEFAULT_PROVIDER, model: DEFAULT_MODEL, effort: null, source: "role-default", sourceKey: null };

  if (own.provider && !own.model) issues.push("provider_without_model");
  const set = Boolean(own.provider || own.model || own.reasoning);
  return {
    providerId: own.provider ?? level.providerId, model: own.model ?? level.model, reasoningEffort: own.reasoning ?? level.effort ?? DEFAULT_REASONING,
    source: set ? "node" : level.source, sourceKey: set ? null : level.sourceKey, inherited: !set, issues,
  };
}
