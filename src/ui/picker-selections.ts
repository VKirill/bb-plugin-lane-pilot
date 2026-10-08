import type { ExperimentalProviderModelPickerValue } from "@get-bb/plugin-sdk/app";
import { DOCS_DEFAULT_SELECTION } from "../rooms/docs/docs-defaults";
import { WRITER_EFFORT, WRITER_MODEL, WRITER_PROVIDER } from "./page-model";

/** The roles whose model is one native picker saved by one RPC (the writer and the council seats have their own flow). */
export type SelectionId = "memory" | "night" | "docs" | "projectLife" | "pmRead" | "onboarding" | "planCritique" | "codeCritique" | "specialist";

export const SELECTION_SPECS: Record<SelectionId, {
  prefix: string;
  rpc: "save_memory_selection" | "save_night_review_selection" | "save_docs_selection" | "save_project_life_selection" | "save_pm_read_selection" | "save_onboarding_selection" | "save_plan_critique_selection" | "save_code_critique_selection" | "save_specialist_selection";
  /** A lost race re-reads the values from the answer ("merge") instead of reloading the whole screen ("reload"). */
  conflict: "reload" | "merge";
  /** The effort when the role has none (and the writer's does not apply). */
  effort: string;
  effortFromWriter?: boolean;
}> = {
  memory: { prefix: "memory", rpc: "save_memory_selection", conflict: "reload", effort: "none", effortFromWriter: true },
  night: { prefix: "night_review", rpc: "save_night_review_selection", conflict: "reload", effort: "high" },
  docs: { prefix: "docs", rpc: "save_docs_selection", conflict: "reload", effort: DOCS_DEFAULT_SELECTION.reasoningLevel },
  projectLife: { prefix: "project_life", rpc: "save_project_life_selection", conflict: "reload", effort: "high" },
  pmRead: { prefix: "pm_read", rpc: "save_pm_read_selection", conflict: "merge", effort: "low" },
  onboarding: { prefix: "onboarding", rpc: "save_onboarding_selection", conflict: "reload", effort: "medium" },
  planCritique: { prefix: "plan_critique", rpc: "save_plan_critique_selection", conflict: "reload", effort: "medium", effortFromWriter: true },
  codeCritique: { prefix: "code_critique", rpc: "save_code_critique_selection", conflict: "reload", effort: "medium", effortFromWriter: true },
  specialist: { prefix: "specialist", rpc: "save_specialist_selection", conflict: "reload", effort: "high" },
};

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
