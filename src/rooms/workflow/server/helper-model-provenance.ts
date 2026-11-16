import type { AgentModel } from "./workflow-agent-model";

/** The resolver's durable passport for a newly spawned generic helper. It contains no settings or prompt material. */
export type HelperModelResolution = {
  role: string;
  requested: {
    providerId?: string;
    model?: string;
    reasoningEffort?: string;
    serviceTier?: "default" | "fast";
  };
  resolved: {
    providerId: string;
    model: string;
    reasoningEffort: string;
    serviceTier: "default" | "fast" | null;
    source: AgentModel["source"];
    sourceKey: string | null;
    inherited: boolean;
    issues: string[];
    /** The resolver selection host, not a later observed execution host. */
    hostId: string | null;
  };
  /** Set only when a provider start/limit fallback selected a new resolver answer. */
  reason?: "provider_start_failure" | "provider_limit";
};

export function assembleHelperModelResolution(input: {
  role: string;
  requested?: HelperModelResolution["requested"];
  providerId?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: "default" | "fast";
  chosen: AgentModel;
  hostId: string | null;
  reason?: HelperModelResolution["reason"];
}): HelperModelResolution {
  const { chosen } = input;
  const requested = input.requested ?? {
    ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
  };
  return {
    role: input.role,
    requested: { ...requested },
    resolved: {
      providerId: chosen.providerId,
      model: chosen.model,
      reasoningEffort: chosen.reasoningEffort,
      serviceTier: chosen.serviceTier,
      source: chosen.source,
      sourceKey: chosen.sourceKey,
      inherited: chosen.inherited,
      issues: [...chosen.issues],
      hostId: input.hostId,
    },
    ...(input.reason ? { reason: input.reason } : {}),
  };
}
