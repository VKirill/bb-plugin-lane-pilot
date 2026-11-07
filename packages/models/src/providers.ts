import type { ModelFamily } from "./role-models";

/**
 * What Lane Pilot knows about a provider that the machine's catalog does not say: the family of models it serves natively (the two
 * native providers cannot serve the other family's model), whether Lane Pilot starts threads on it at all, and the settings screen's
 * label. A provider with no row here is an ordinary one: any model of it is a pair that can run.
 */
export type ProviderCapabilities = {
  /** The only family of models the provider serves; a model of another family is not a pair that can run. */
  family?: ModelFamily;
  /** The core advertises the provider but Lane Pilot starts no thread on it (OpenCode v1). */
  notStarted?: boolean;
  /** The settings screen's own label for the provider. */
  labelKey?: string;
};

export const PROVIDER_CAPABILITIES: Readonly<Record<string, ProviderCapabilities>> = {
  "claude-code": { family: "claude", labelKey: "accessProviderClaudeCode" },
  codex: { family: "gpt", labelKey: "accessProviderCodex" },
  // OpenCode v2 runs one shared service per machine: the bridge turns skills and MCP servers into the session's permission rules.
  opencode2: { labelKey: "accessProviderOpencode" },
  // The core still advertises OpenCode v1; Lane Pilot starts no thread on it (the match is exact, see CORE_PROVIDER_GROUPS).
  "acp-opencode": { notStarted: true },
  "acp-cursor": { labelKey: "accessProviderCursor" },
};

/** The family of models a provider serves natively, when it serves only one. */
export function nativeProviderFamily(providerId: string): ModelFamily | undefined {
  return PROVIDER_CAPABILITIES[providerId]?.family;
}
