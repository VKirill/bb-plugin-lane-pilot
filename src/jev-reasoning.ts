export type JevStatus = "ok"|"disabled"|"timeout"|"error";
const SDK_REASONING_LEVELS = new Set(["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"]);

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

export function writerExecutionSelection(providerId:string, model:string, reasoningLevel:string, serviceTier:BbServiceTier|null) {
  return {
    providerId,
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
