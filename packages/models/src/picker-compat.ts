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
  // Standard needs no listing: a provider that names only "fast" (Devin) still runs its models at the normal speed.
  if (requested !== "fast") return "default";
  if (supported.includes("fast")) return "fast";
  return supported.includes("default") ? "default" : null;
}
