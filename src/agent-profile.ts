import { createHash } from "node:crypto";
import { z } from "zod";

export const MAIN_AGENT_PROFILE_IDS = [
  "dev-orchestrator",
  "copy-lead",
  "seo-specialist",
] as const;
export type MainAgentProfileId = (typeof MAIN_AGENT_PROFILE_IDS)[number];

export const compiledMainAgentSchema = z.object({
  id: z.enum(MAIN_AGENT_PROFILE_IDS),
  sourceVersion: z.string().min(1),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  description: z.string().min(1).max(400),
  prompt: z.string().min(1).max(32_000),
  tools: z.array(z.string().min(1)).max(64).optional(),
  disallowedTools: z.array(z.string().min(1)).max(64).optional(),
  skills: z.array(z.string().min(1)).max(64).optional(),
  mcpServers: z.array(z.string().min(1)).max(64).optional(),
}).strict();
export type CompiledMainAgent = z.infer<typeof compiledMainAgentSchema>;

const PROFILE_SOURCE_VERSION = "lp-owned-1";

const TEMPLATES: Record<MainAgentProfileId, { description: string; prompt: string }> = {
  "dev-orchestrator": {
    description: "Lane Pilot development orchestrator",
    prompt: "You are the Lane Pilot development orchestrator. Coordinate implementation, keep changes surgical, and stop at the requested verification.",
  },
  "copy-lead": {
    description: "Lane Pilot copy lead",
    prompt: "You are the Lane Pilot copy lead. Write and edit user-facing text. Do not change runtime behavior unless the task says so.",
  },
  "seo-specialist": {
    description: "Lane Pilot SEO specialist",
    prompt: "You are the Lane Pilot SEO specialist. Work only on search and metadata tasks in the requested paths.",
  },
};

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function compileMainAgentProfile(
  id: string,
  overrides?: { prompt?: string; description?: string },
): CompiledMainAgent {
  if (!MAIN_AGENT_PROFILE_IDS.includes(id as MainAgentProfileId)) {
    throw new Error(`unsupported_main_agent_profile:${id}`);
  }
  const template = TEMPLATES[id as MainAgentProfileId];
  const description = overrides?.description?.trim() || template.description;
  const prompt = overrides?.prompt?.trim() || template.prompt;
  if (!description || !prompt) throw new Error(`incomplete_main_agent_profile:${id}`);
  const unsigned = {
    id,
    sourceVersion: PROFILE_SOURCE_VERSION,
    description,
    prompt,
  };
  const profile = compiledMainAgentSchema.parse({
    ...unsigned,
    sourceHash: sha256(JSON.stringify(unsigned)),
  });
  if ("model" in profile || "permissionMode" in profile) {
    throw new Error("compiled_main_agent_must_omit_model_and_permissionMode");
  }
  return profile;
}

export function compiledMainAgentSpawnField(profile: CompiledMainAgent): {
  experimental_vkCompiledMainAgent: CompiledMainAgent;
} {
  return { experimental_vkCompiledMainAgent: compiledMainAgentSchema.parse(profile) };
}

export function detectCompiledMainAgentCapability(agents: {
  experimental_vkCompiledMainAgent?: unknown;
}): "supported" | "none" {
  if (typeof agents.experimental_vkCompiledMainAgent !== "function") return "none";
  const advertised = (agents.experimental_vkCompiledMainAgent as () => unknown)();
  if (
    advertised !== null &&
    typeof advertised === "object" &&
    (advertised as { persist?: unknown }).persist === true &&
    (advertised as { bridgeAgentOptions?: unknown }).bridgeAgentOptions === true &&
    (advertised as { requiredMarker?: unknown }).requiredMarker === true &&
    Array.isArray((advertised as { providerIds?: unknown }).providerIds) &&
    (advertised as { providerIds: unknown[] }).providerIds.includes("claude-code")
  ) {
    return "supported";
  }
  return "none";
}

export function resolveSelectedMainAgentProfile(
  settings: Record<string, unknown>,
): CompiledMainAgent | null {
  const raw = settings["main.agent"];
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new Error("main_agent_invalid");
  return compileMainAgentProfile(raw);
}

export function compiledMainAgentSpawnBinding(input: {
  capability: "supported" | "none";
  profile: CompiledMainAgent | null;
}): { experimental_vkCompiledMainAgent: CompiledMainAgent } | Record<string, never> {
  if (input.profile === null) return {};
  if (input.capability !== "supported") {
    throw new Error("compiled_main_agent_unsupported");
  }
  return compiledMainAgentSpawnField(input.profile);
}
