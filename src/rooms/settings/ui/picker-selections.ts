import type { ExperimentalProviderModelPickerValue } from "@get-bb/plugin-sdk/app";
import { DOCS_DEFAULT_SELECTION } from "../../docs/docs-defaults";
import { WRITER_EFFORT, WRITER_MODEL, WRITER_PROVIDER } from "../../ui-shell/ui/page-model";
import { ROLE_SPECS, type RoleSelectionId } from "@lane-pilot/models";

/** The roles whose model is one native picker saved by one RPC (the writer and the council seats have their own flow). */
export type SelectionId = RoleSelectionId;

type SelectionSpec = {
  prefix: string;
  rpc: "save_memory_selection" | "save_night_review_selection" | "save_docs_selection" | "save_project_life_selection" | "save_pm_read_selection" | "save_onboarding_selection" | "save_plan_critique_selection" | "save_code_critique_selection" | "save_specialist_selection";
  /** The effort when the role has none (and the writer's does not apply). */
  effort: string;
  effortFromWriter?: boolean;
};

export const SELECTION_SPECS = Object.fromEntries(ROLE_SPECS.flatMap((spec) => spec.selectionId && spec.prefix
  ? [[spec.selectionId, {
    prefix: spec.prefix,
    rpc: spec.rpc as SelectionSpec["rpc"],
    effort: spec.defaultEffort ?? "medium",
    ...(spec.effortFromWriter ? { effortFromWriter: true } : {}),
  }]]
  : [])) as Record<SelectionId, SelectionSpec>;

export function selectionKeys(id: SelectionId) {
  const { prefix } = SELECTION_SPECS[id];
  return { provider: `${prefix}.provider`, model: `${prefix}.model`, effort: `${prefix}.reasoning_effort`, tier: `${prefix}.service_tier` };
}

type Level = ExperimentalProviderModelPickerValue["reasoningLevel"];
type ProviderList = { providers?: ReadonlyArray<{ id: string; serviceTiers?: ReadonlyArray<unknown> }> | null };

/** What the picker of a role shows: its own pair, else the writer's (docs and the project log have their own defaults). */
export function selectionValue(id: SelectionId, values: Record<string, unknown> | undefined, providers: ProviderList): ExperimentalProviderModelPickerValue {
  const v = values ?? {};
  const spec = SELECTION_SPECS[id];
  const keys = selectionKeys(id);
  const hasTiers = (providerId: string) => Boolean(providers.providers?.find((provider) => provider.id === providerId)?.serviceTiers?.length);
  if (id === "docs") {
    const own = Boolean(v[keys.provider] && v[keys.model]);
    const providerId = String(own ? v[keys.provider] : DOCS_DEFAULT_SELECTION.providerId);
    return {
      providerId,
      model: String(own ? v[keys.model] : DOCS_DEFAULT_SELECTION.model),
      reasoningLevel: (String(v[keys.effort] ?? DOCS_DEFAULT_SELECTION.reasoningLevel) || DOCS_DEFAULT_SELECTION.reasoningLevel) as Level,
      ...(hasTiers(providerId) ? { serviceTier: v[keys.tier] === "standard" || v[keys.tier] === "default" ? "default" : (v[keys.tier] === "fast" || !own) ? "fast" : "default" } : {}),
    };
  }
  if (id === "projectLife") {
    const providerId = String(v[keys.provider] ?? "codex");
    return {
      providerId,
      model: String(v[keys.model] ?? "gpt-6-luna"),
      reasoningLevel: (String(v[keys.effort] ?? "high") || "high") as Level,
      ...(hasTiers(providerId) ? { serviceTier: v[keys.tier] === "standard" ? "default" : "fast" } : {}),
    };
  }
  const providerId = String(v[keys.provider] ?? v[WRITER_PROVIDER] ?? "");
  const effort = String((spec.effortFromWriter ? v[keys.effort] ?? v[WRITER_EFFORT] : v[keys.effort]) ?? spec.effort) || spec.effort;
  return {
    providerId,
    model: String(v[keys.model] ?? v[WRITER_MODEL] ?? ""),
    reasoningLevel: effort as Level,
    ...(hasTiers(providerId) ? { serviceTier: v[keys.tier] === "fast" ? "fast" : "default" } : {}),
  };
}
