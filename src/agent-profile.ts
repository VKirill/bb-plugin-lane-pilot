import { createHash } from "node:crypto";
import { z } from "zod";

export const MAIN_AGENT_PROFILE_IDS = [
  "dev-orchestrator",
  "copy-lead",
  "seo-specialist",
  "design-lead",
  "project-onboarder",
  "tavily",
] as const;
export type MainAgentProfileId = (typeof MAIN_AGENT_PROFILE_IDS)[number];

export const compiledMainAgentSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
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

export const PROFILE_SOURCE_VERSION = "lp-owned-2";

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
  "design-lead": { description: "Lane Pilot design specialist", prompt: "Design accessible interfaces using the project's native components and design rules. Verify interaction states and preserve user drafts." },
  "project-onboarder": { description: "Lane Pilot project onboarder", prompt: "Read the project instructions and source of truth. Establish the project scope, existing environment and verification commands before proposing changes." },
  tavily: { description: "Lane Pilot research specialist", prompt: "Research the requested question using available search tools. Cite primary sources, distinguish evidence from inference, and report uncertainty." },
};

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export type ProfileResources = Pick<CompiledMainAgent, "tools" | "disallowedTools" | "skills" | "mcpServers">;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonicalValue(child)]));
  return value;
}

export function compiledMainAgentDigest(body: Omit<CompiledMainAgent, "sourceHash">): string {
  const ordered = { id: body.id, sourceVersion: body.sourceVersion, description: body.description, prompt: body.prompt,
    ...(body.tools ? { tools: body.tools } : {}), ...(body.disallowedTools ? { disallowedTools: body.disallowedTools } : {}),
    ...(body.skills ? { skills: body.skills } : {}), ...(body.mcpServers ? { mcpServers: body.mcpServers } : {}) };
  // v1 preserves the original field order; v2 recursively canonicalizes object keys.
  const canonical = body.sourceVersion === "lp-owned-1" ? ordered : canonicalValue(ordered);
  return sha256(JSON.stringify(canonical));
}

export function validateCompiledMainAgent(raw: unknown): CompiledMainAgent {
  const profile = compiledMainAgentSchema.parse(raw);
  const { sourceHash, ...body } = profile;
  if (compiledMainAgentDigest(body) !== sourceHash) throw new Error("main_agent_digest_mismatch");
  return profile;
}

export function compileMainAgentProfile(
  id: string,
  overrides?: { prompt?: string; description?: string } & ProfileResources,
): CompiledMainAgent {
  if (!MAIN_AGENT_PROFILE_IDS.includes(id as MainAgentProfileId) && (!overrides?.prompt?.trim() || !overrides?.description?.trim())) {
    throw new Error(`unsupported_main_agent_profile:${id}`);
  }
  const template = TEMPLATES[id as MainAgentProfileId];
  const description = overrides?.description?.trim() || template?.description;
  const prompt = overrides?.prompt?.trim() || template?.prompt;
  if (!description || !prompt) throw new Error(`incomplete_main_agent_profile:${id}`);
  const unsigned = {
    id,
    sourceVersion: PROFILE_SOURCE_VERSION,
    description,
    prompt,
    ...(overrides?.tools ? { tools: overrides.tools } : {}),
    ...(overrides?.disallowedTools ? { disallowedTools: overrides.disallowedTools } : {}),
    ...(overrides?.skills ? { skills: overrides.skills } : {}),
    ...(overrides?.mcpServers ? { mcpServers: overrides.mcpServers } : {}),
  };
  const profile = compiledMainAgentSchema.parse({
    ...unsigned,
    sourceHash: compiledMainAgentDigest(unsigned),
  });
  if ("model" in profile || "permissionMode" in profile) {
    throw new Error("compiled_main_agent_must_omit_model_and_permissionMode");
  }
  return profile;
}

export function compiledMainAgentSpawnField(profile: CompiledMainAgent): {
  experimental_vkCompiledMainAgent: CompiledMainAgent;
} {
  return { experimental_vkCompiledMainAgent: validateCompiledMainAgent(profile) };
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
  owned: Record<string, { prompt?: string; description?: string; compiled?: CompiledMainAgent }> = {},
): CompiledMainAgent | null {
  const raw = settings["main.agent"];
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new Error("main_agent_invalid");
  const saved = Object.prototype.hasOwnProperty.call(owned, raw) ? owned[raw] : undefined;
  if (saved?.compiled) {
    const profile = validateCompiledMainAgent(saved.compiled);
    if (profile.id !== raw) throw new Error("main_agent_id_mismatch");
    return profile;
  }
  return compileMainAgentProfile(raw, saved);
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
