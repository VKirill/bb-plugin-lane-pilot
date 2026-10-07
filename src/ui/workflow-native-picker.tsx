import { experimental_ProviderModelPicker as ProviderModelPicker, type ExperimentalProviderModelPickerProps, type ExperimentalProviderModelPickerValue } from "@get-bb/plugin-sdk/app";
import { findModel, findProvider, nodeEffortsFor, type ModelCatalog } from "../workflow/model-catalog";
import type { ModelChoice } from "./workflow-model-ops";

/**
 * BB's own provider/model window (the composer's: provider tabs, model search, «Reasoning», «Fast mode»), used for every place a
 * step's model is chosen: the node panel, the Models table and the card on the graph. The window and its list come from the host
 * (`experimental_ProviderModelPicker`); this wrapper only feeds it a value and turns what it answers into a `ModelChoice` the
 * draft can take. It does not need a machine of the page: the catalog of the hub says which machine to ask.
 */
export type PickerSeed = { providerId: string | null; model: string | null; effort: string | null; serviceTier: string | null };

type Level = ExperimentalProviderModelPickerValue["reasoningLevel"];
const LEVELS: ReadonlySet<string> = new Set(["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"]);

/** The value the window opens on: what the step runs on now, else the first provider a machine has with its own default model. */
export function pickerValue(catalog: ModelCatalog, seed: PickerSeed): ExperimentalProviderModelPickerValue | null {
  const named = seed.providerId ? findProvider(catalog, seed.providerId) : undefined;
  const provider = named ?? catalog.providers.find((row) => row.hostIds.length > 0 && row.models.some((item) => item.hostIds.length > 0));
  if (!provider && !seed.providerId) return null;
  const providerId = seed.providerId ?? provider!.id;
  const offered = provider?.models.filter((row) => row.hostIds.length > 0) ?? [];
  const model = seed.model ?? (offered.find((row) => row.isDefault) ?? offered[0])?.id ?? "";
  const known = findModel(provider, model);
  const wanted = seed.effort && LEVELS.has(seed.effort) ? seed.effort : known?.defaultEffort && LEVELS.has(known.defaultEffort) ? known.defaultEffort : known?.efforts.length ? "medium" : "none";
  const serviceTier = seed.serviceTier === "fast" ? "fast" : provider?.supportsServiceTier ? "default" : undefined;
  return { providerId, model, reasoningLevel: wanted as Level, ...(serviceTier ? { serviceTier } : {}) };
}

/** The machine the window asks for the live list: one that has the provider, else any connected one, else the first; none leaves it to BB's primary machine. */
export function pickerRouting(catalog: ModelCatalog, providerId: string): ExperimentalProviderModelPickerProps["routing"] {
  const provider = findProvider(catalog, providerId);
  const connected = catalog.hosts.filter((host) => host.connected);
  const host = connected.find((item) => provider?.hostIds.includes(item.id)) ?? connected[0] ?? catalog.hosts[0];
  return host ? { kind: "host", hostId: host.id } : undefined;
}

/** What the window answered, as a choice for a node: an effort the node cannot hold is dropped, fast mode is kept only as `fast`. */
export function choiceFromPicker(catalog: ModelCatalog, next: ExperimentalProviderModelPickerValue): ModelChoice {
  const model = findModel(findProvider(catalog, next.providerId), next.model);
  const effort = next.reasoningLevel !== "none" && nodeEffortsFor(model).includes(next.reasoningLevel) ? next.reasoningLevel : null;
  return { providerId: next.providerId, model: model?.id ?? next.model, effort, serviceTier: next.serviceTier === "fast" ? "fast" : null };
}

export function NativeModelPicker({ catalog, seed, disabled = false, onChoose, testId, className, align = "start", label }: {
  catalog: ModelCatalog; seed: PickerSeed; disabled?: boolean; onChoose: (choice: ModelChoice) => void; testId: string; className?: string;
  align?: "start" | "center" | "end"; label?: string;
}) {
  const value = pickerValue(catalog, seed);
  if (!value) return null;
  const routing = pickerRouting(catalog, value.providerId);
  return (
    // The window sits on a card that selects on click and a canvas that pans on drag: neither may take the gesture.
    <div className={`lp-native-picker nodrag nopan ${className ?? ""}`} data-testid={testId} data-provider={value.providerId} data-model={value.model} aria-label={label}
      onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <ProviderModelPicker value={value} disabled={disabled} align={align} {...(routing ? { routing } : {})} onChange={(next) => onChoose(choiceFromPicker(catalog, next))} />
    </div>
  );
}
