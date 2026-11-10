import { bundledAgents } from "../contracts";
import { STREAMS } from "../session-hooks";
import { REQUIRED_CAPABILITIES } from "./capabilities";

/**
 * Capability registry (SMA k_t_capreg): every feature capability Lane Pilot ships and, per runtime,
 * the agents, skills and hooks it brings. Derived at read time from the bundled agent catalog, the
 * session-hook streams and the opencode capability contract, so a new bundle entry appears here
 * without a second list to keep.
 */
export type FeatureRuntime = "claude" | "opencode";
export type FeatureCapability = {
  id: string;
  agents: Partial<Record<FeatureRuntime, readonly string[]>>;
  skills: Partial<Record<FeatureRuntime, readonly string[]>>;
  hooks: Partial<Record<FeatureRuntime, readonly string[]>>;
};

/** The opencode hooks the lane plugin registers (its half of the guard layer). */
const OPENCODE_HOOKS = REQUIRED_CAPABILITIES.filter((capability) => capability.startsWith("opencode.hook."));

export function featureRegistry(): FeatureCapability[] {
  const agents = bundledAgents as Record<string, { skills?: string[] }>;
  const features: FeatureCapability[] = Object.entries(agents).map(([id, agent]) => ({
    id,
    agents: { claude: [id], opencode: [id] },
    skills: { claude: agent.skills ?? [], opencode: agent.skills ?? [] },
    hooks: {},
  }));
  features.push({
    id: "session-guard",
    agents: {},
    skills: {},
    hooks: { claude: [...STREAMS], opencode: [...OPENCODE_HOOKS] },
  });
  return features;
}

/**
 * Missing links of the registry: an agent or skill a feature names that the bundle does not ship,
 * or a hook stream the guard feature names that session-hooks does not run.
 */
export function featureRegistryGaps(registry: readonly FeatureCapability[] = featureRegistry()): string[] {
  const agents = bundledAgents as Record<string, { skills?: string[] }>;
  const bundledSkill = new Set<string>();
  for (const agent of Object.values(agents)) for (const skill of agent.skills ?? []) bundledSkill.add(skill);
  const bundledAgent = new Set(Object.keys(agents));
  const bundledHook = new Set<string>([...STREAMS, ...REQUIRED_CAPABILITIES]);
  const gaps: string[] = [];
  for (const feature of registry) {
    const check = (kind: "agent" | "skill" | "hook", names: readonly string[] | undefined, known: ReadonlySet<string>) => {
      for (const name of names ?? []) if (!known.has(name)) gaps.push(`${feature.id}: unknown ${kind} ${name}`);
    };
    for (const runtime of ["claude", "opencode"] as const) {
      check("agent", feature.agents[runtime], bundledAgent);
      check("skill", feature.skills[runtime], bundledSkill);
      check("hook", feature.hooks[runtime], bundledHook);
    }
  }
  return gaps;
}
