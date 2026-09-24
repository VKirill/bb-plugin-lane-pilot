export function compatibleReasoningLevel(
  requested: string,
  supported: readonly string[],
  defaultReasoningEffort: string | undefined,
): string | null {
  if (supported.includes(requested)) return requested;
  if (defaultReasoningEffort && supported.includes(defaultReasoningEffort)) {
    return defaultReasoningEffort;
  }
  return null;
}

export function compatibleServiceTier(
  requested: "default" | "fast" | null,
  supported: readonly string[],
): "default" | "fast" | null {
  if (requested && supported.includes(requested)) return requested;
  if (supported.includes("default")) return "default";
  return null;
}
