import { createHash } from "node:crypto";
import { z } from "zod";

export const MAIN_AGENT_ID = /^[a-z][a-z0-9-]{0,63}$/;
export const MAIN_AGENT_PROFILE_IDS = [
  "dev-orchestrator",
  "copy-lead",
  "seo-specialist",
  "design-lead",
  "project-onboarder",
  "tavily",
] as const;

export const compiledMainAgentSchema = z.object({
  id: z.string().regex(MAIN_AGENT_ID),
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
export type ProfileResources = Pick<CompiledMainAgent, "tools" | "disallowedTools" | "skills" | "mcpServers">;

export type StoredAgentRow = {
  prompt?: string;
  description?: string;
  compiled?: CompiledMainAgent;
  compiledCorrupt?: true;
};

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalizeJson(nested)]),
    );
  }
  return value;
}

export function compiledMainAgentDigest(body: Omit<CompiledMainAgent, "sourceHash">): string {
  const ordered = {
    id: body.id,
    sourceVersion: body.sourceVersion,
    description: body.description,
    prompt: body.prompt,
    ...(body.tools ? { tools: body.tools } : {}),
    ...(body.disallowedTools ? { disallowedTools: body.disallowedTools } : {}),
    ...(body.skills ? { skills: body.skills } : {}),
    ...(body.mcpServers ? { mcpServers: body.mcpServers } : {}),
  };
  const canonical = body.sourceVersion === "lp-owned-1" ? ordered : canonicalizeJson(ordered);
  return sha256(JSON.stringify(canonical));
}

export function validateCompiledMainAgent(raw: unknown): CompiledMainAgent {
  const profile = compiledMainAgentSchema.parse(raw);
  const { sourceHash, ...body } = profile;
  if (compiledMainAgentDigest(body) !== sourceHash) throw new Error("main_agent_digest_mismatch");
  if ("model" in profile || "permissionMode" in profile) {
    throw new Error("compiled_main_agent_must_omit_model_and_permissionMode");
  }
  return profile;
}

const TEMPLATES: Record<string, { description: string; prompt: string }> = {
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
  "design-lead": {
    description: "Lane Pilot design lead",
    prompt: "You are the Lane Pilot design lead. Work on interface and visual tasks in the requested paths. Do not change runtime behavior unless the task says so.",
  },
  "project-onboarder": {
    description: "Lane Pilot project onboarder",
    prompt: "You are the Lane Pilot project onboarder. Write bounded onboarding and orientation material for this repository.",
  },
  tavily: {
    description: "Lane Pilot Tavily research agent",
    prompt: "You are the Lane Pilot Tavily research agent. Search and summarize only what the task asks. Do not change runtime files unless the task says so.",
  },
};

export function isMainAgentProfileId(id: string): boolean {
  return MAIN_AGENT_ID.test(id);
}

export function compileMainAgentProfile(
  id: string,
  overrides?: { prompt?: string; description?: string } & ProfileResources,
): CompiledMainAgent {
  if (!isMainAgentProfileId(id)) {
    throw new Error(`invalid_main_agent_profile_id:${id}`);
  }
  const template = TEMPLATES[id];
  const description = overrides?.description?.trim() || template?.description || "";
  const prompt = overrides?.prompt?.trim() || template?.prompt || "";
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
  return validateCompiledMainAgent({
    ...unsigned,
    sourceHash: compiledMainAgentDigest(unsigned),
  });
}

export function parseOwnedAgents(raw: unknown): Record<string, StoredAgentRow> {
  if (!raw || typeof raw !== "object") return {};
  const owned: Record<string, StoredAgentRow> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isMainAgentProfileId(id) || !value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const base: StoredAgentRow = {
      ...(typeof row.prompt === "string" ? { prompt: row.prompt } : {}),
      ...(typeof row.description === "string" ? { description: row.description } : {}),
    };
    if (!("compiled" in row) || row.compiled === undefined) {
      owned[id] = base;
      continue;
    }
    try {
      const compiled = validateCompiledMainAgent(row.compiled);
      owned[id] = compiled.id === id ? { ...base, compiled } : { ...base, compiledCorrupt: true };
    } catch {
      owned[id] = { ...base, compiledCorrupt: true };
    }
  }
  return owned;
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
    (advertised as { snapshotDigest?: unknown }).snapshotDigest === true &&
    Array.isArray((advertised as { providerIds?: unknown }).providerIds) &&
    (advertised as { providerIds: unknown[] }).providerIds.includes("claude-code")
  ) {
    return "supported";
  }
  return "none";
}

export function resolveSelectedMainAgentProfile(
  settings: Record<string, unknown>,
  owned: Record<string, StoredAgentRow> = {},
): CompiledMainAgent | null {
  const raw = settings["main.agent"];
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new Error("main_agent_invalid");
  const stored = owned[raw];
  if (stored?.compiledCorrupt) throw new Error(`compiled_main_agent_corrupt:${raw}`);
  if (stored?.compiled) {
    const profile = validateCompiledMainAgent(stored.compiled);
    if (profile.id !== raw) throw new Error("main_agent_id_mismatch");
    return profile;
  }
  return compileMainAgentProfile(raw, stored);
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
