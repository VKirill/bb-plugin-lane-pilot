import { consistentProvider } from "./role-models";

/** The reasoning efforts the SDK accepts: the settings enum and the writer's effort resolver read this one list. */
export const REASONING_LEVELS = ["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"] as const;
const SDK_REASONING_LEVELS: ReadonlySet<string> = new Set(REASONING_LEVELS);

/**
 * The writer's effort is the setting (`writer.reasoning_effort`), clamped to what the live catalog lists for the model: a catalog that
 * lists fewer efforts than the setting (Devin right after a hub restart, 2026-11-12: «supported=medium» for a high writer blocked every
 * task) takes the nearest listed effort, a higher one on a tie; the reason records it. No decision is taken by a model.
 */
export function resolveWriterReasoning(input:{
  manualLevel:string;
  supportedLevels:ReadonlySet<string>|null;
}): { requested:string; effective:string; fallbackReason:string|null; manualSupported:boolean|null } {
  const requested = input.manualLevel;
  let effective = input.manualLevel;
  let fallbackReason:string|null = input.supportedLevels === null ? "selected_model_catalog_unavailable" : null;
  const manualSupported = !SDK_REASONING_LEVELS.has(input.manualLevel)
    ? false
    : input.supportedLevels === null ? null : input.supportedLevels.has(input.manualLevel);
  if (manualSupported === false && SDK_REASONING_LEVELS.has(input.manualLevel) && input.supportedLevels?.size) {
    const at = (level:string) => REASONING_LEVELS.indexOf(level as typeof REASONING_LEVELS[number]);
    const nearest = [...input.supportedLevels].filter((level) => at(level) >= 0)
      .sort((a, b) => Math.abs(at(a) - at(input.manualLevel)) - Math.abs(at(b) - at(input.manualLevel)) || at(b) - at(a))[0];
    if (nearest) {
      effective = nearest;
      fallbackReason = [fallbackReason, `manual_effort_clamped:${input.manualLevel}->${nearest}`].filter(Boolean).join(";");
    }
  }
  return { requested, effective, fallbackReason, manualSupported };
}

export type WriterServiceTier = "standard" | "fast";
export type BbServiceTier = "default" | "fast";

export function writerServiceTier(settings: Readonly<Record<string, unknown>>): WriterServiceTier {
  const explicit = settings["writer.service_tier"];
  if (explicit === "standard" || explicit === "fast") return explicit;
  const legacy = settings["writer.fast_mode"];
  if (legacy === true || legacy === 1 || (typeof legacy === "string" && ["1", "true", "on"].includes(legacy.trim().toLowerCase()))) {
    return "fast";
  }
  return "standard";
}

export function bbServiceTier(tier: WriterServiceTier): BbServiceTier {
  return tier === "fast" ? "fast" : "default";
}

/**
 * The tier a helper's spawn names: none when the provider has no tiers, and none for the normal speed when the provider lists only
 * "fast" (Devin) — the normal speed is its default then. A "fast" the provider lacks stays, for the caller to refuse.
 */
export function listedServiceTier(provider: { capabilities: { supportsServiceTier?: boolean }; serviceTiers?: Array<{ id: string }> }, tier: BbServiceTier): BbServiceTier | null {
  if (!provider.capabilities.supportsServiceTier) return null;
  if (tier === "default" && !(provider.serviceTiers ?? []).some((item) => item.id === "default")) return null;
  return tier;
}

export function writerExecutionSelection(
  providerId:string,
  model:string,
  reasoningLevel:string,
  serviceTier:BbServiceTier|null,
) {
  // The last stop before a spawn for every wrapper: a provider and a model are never sent as a pair that cannot exist (a GPT model on claude-code).
  return {
    providerId:consistentProvider(providerId, model) ?? providerId,
    model,
    reasoningLevel:reasoningLevel as "none"|"low"|"medium"|"high"|"xhigh"|"ultracode"|"max"|"ultra",
    ...(serviceTier ? { serviceTier } : {}),
    executionInputSources:{
      providerId:"explicit" as const,
      model:"explicit" as const,
      reasoningLevel:"explicit" as const,
      ...(serviceTier ? { serviceTier:"explicit" as const } : {}),
    },
  };
}
