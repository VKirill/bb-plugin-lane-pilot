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
  /** Its start is refused by the machine's TCC protection of ~/Documents (an observed EPERM), so the refusal is remembered per machine. */
  documentsFolderSensitive?: boolean;
  /** Its bridge forwards every text part of a message, agent-only ones included, so a brief can hide the contract from the chat. */
  forwardsAgentOnly?: boolean;
  /** Its writer runs with its own fresh home per task (`worker.strict_user`), which the shim prepares. */
  requiresWorkerHome?: boolean;
  /** Its runtime reads Claude Code hooks, so the harness writes `.claude/settings.local.json` for it. */
  supportsHookSettings?: boolean;
  /** Its small models take the fast service tier (asked of it only). */
  supportsFastTier?: boolean;
  /** Threads it starts carry Lane Pilot's own agent (the lane hooks act only in such a session). */
  usesLaneAgent?: boolean;
  /** A provider id a usage source may list its quota under (a router in front of it), for the models that name the router. */
  usageProviderId?: string;
};

export const PROVIDER_CAPABILITIES: Readonly<Record<string, ProviderCapabilities>> = {
  "claude-code": { family: "claude", labelKey: "accessProviderClaudeCode", forwardsAgentOnly: true, supportsHookSettings: true },
  codex: { family: "gpt", labelKey: "accessProviderCodex", forwardsAgentOnly: true, requiresWorkerHome: true, supportsFastTier: true },
  // OpenCode v2 runs one shared service per machine: the bridge turns skills and MCP servers into the session's permission rules.
  // Its serve EPERM'd in ~/Documents on the Mac mini (2026-10-30, vk_required_session_policy_unenforceable_mcp_servers).
  opencode2: { labelKey: "accessProviderOpencode", documentsFolderSensitive: true, forwardsAgentOnly: true, usesLaneAgent: true, usageProviderId: "router9" },
  devin: { forwardsAgentOnly: true },
  // The core still advertises OpenCode v1; Lane Pilot starts no thread on it (the match is exact, see CORE_PROVIDER_GROUPS).
  "acp-opencode": { notStarted: true },
  "acp-cursor": { labelKey: "accessProviderCursor" },
};

/** The family of models a provider serves natively, when it serves only one. */
export function nativeProviderFamily(providerId: string): ModelFamily | undefined {
  return PROVIDER_CAPABILITIES[providerId]?.family;
}

/** Whether the provider's bridge forwards `agent-only` text parts (every ACP agent does; the prefix is the protocol family, not one provider). */
export function providerForwardsAgentOnly(providerId: string): boolean {
  return PROVIDER_CAPABILITIES[providerId]?.forwardsAgentOnly === true || providerId.startsWith("acp-");
}

/** The provider id a usage source lists this provider's quota under, when the model runs through that router; null otherwise. */
export function usageProviderOf(providerId: string, model: string): string | null {
  const router = PROVIDER_CAPABILITIES[providerId]?.usageProviderId;
  return router && model.startsWith(`${router}/`) ? router : null;
}
