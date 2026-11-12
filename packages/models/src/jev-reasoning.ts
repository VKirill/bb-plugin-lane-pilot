import { consistentProvider } from "./role-models";
import { settingOff } from "./setting-value";

export type JevStatus = "ok"|"disabled"|"timeout"|"error";
/** The reasoning efforts the SDK accepts: the settings enum and the Jev resolver read this one list. */
export const REASONING_LEVELS = ["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"] as const;
const SDK_REASONING_LEVELS: ReadonlySet<string> = new Set(REASONING_LEVELS);

export function resolveJevReasoning(input:{
  status:JevStatus;
  jevDecision:string|null;
  manualLevel:string;
  supportedLevels:ReadonlySet<string>|null;
}): { requested:string; effective:string; fallbackReason:string|null; manualSupported:boolean|null } {
  const requested = input.status === "ok" ? input.jevDecision ?? input.manualLevel : input.manualLevel;
  let fallbackReason:string|null = null;
  if (input.status !== "ok") fallbackReason = `jev_${input.status}`;
  else if (!input.jevDecision) fallbackReason = "jev_missing_effort_answer";
  else if (input.supportedLevels && !input.supportedLevels.has(input.jevDecision)) {
    fallbackReason = `jev_unsupported_by_selected_model:${input.jevDecision}`;
  }
  let effective = requested;
  if (input.supportedLevels === null) fallbackReason = [fallbackReason, "selected_model_catalog_unavailable"].filter(Boolean).join(";");
  else if (input.status === "ok" && input.jevDecision && !input.supportedLevels.has(input.jevDecision)) effective = input.manualLevel;
  if (input.status !== "ok" || !input.jevDecision || input.supportedLevels === null) effective = input.manualLevel;
  const manualSupported = !SDK_REASONING_LEVELS.has(input.manualLevel)
    ? false
    : input.supportedLevels === null ? null : input.supportedLevels.has(input.manualLevel);
  // A live catalog that lists fewer efforts than the setting (Devin right after a hub restart, 2026-11-12: «supported=medium»
  // for a high writer blocked every task) takes the nearest listed effort, a higher one on a tie; the reason records it.
  if (manualSupported === false && SDK_REASONING_LEVELS.has(input.manualLevel) && effective === input.manualLevel && input.supportedLevels?.size) {
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
export type ExecutionFieldSource = "explicit" | "client-preference";

export function automaticEffortRoutingEnabled(settings: Readonly<Record<string, unknown>>): boolean {
  return !settingOff(settings["jev.LANE_JEV_EFFORT"]);
}

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
  sources?: { reasoningLevel?: ExecutionFieldSource },
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
      reasoningLevel:sources?.reasoningLevel ?? "explicit",
      ...(serviceTier ? { serviceTier:"explicit" as const } : {}),
    },
  };
}
