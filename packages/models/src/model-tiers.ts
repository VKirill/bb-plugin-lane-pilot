/**
 * How much judgment a model brings, for the roles that decide (the planner, the auditor, the code critic): `light` models (Haiku,
 * Luna, GLM Flash, a Flash at low) read and collect well and are cheap; `standard` (Sonnet, a Gemini Flash, GPT-5.6, Composer) write
 * and check; `strong` (Opus, Fable, GPT-6 Sol, Gemini Pro and Argon) plan and audit. An unknown model has no tier and is not judged.
 * The guard of 2026-10-25: the planner borrowed the plan critic's Haiku, and Haiku wrote every phase plan.
 */
export type ModelTier = "light" | "standard" | "strong";

const TIERS: Array<[RegExp, ModelTier]> = [
  [/haiku|luna|glm-[\d.]+-flash|flash-low|flash-lite|-mini\b/i, "light"],
  [/opus|fable|mythos|gpt-6(\.\d+)?-sol|gpt-6-astra|gemini-[\w.-]*pro|gemini-4-argon|pro-latest/i, "strong"],
  [/sonnet|gemini-[\w.-]*flash|flash-latest|gpt-5\.\d+-(sol|terra)|gpt-6-terra|composer/i, "standard"],
];

export function modelTier(model: string): ModelTier | null {
  for (const [pattern, tier] of TIERS) if (pattern.test(model)) return tier;
  return null;
}

const RANK: Record<ModelTier, number> = { light: 0, standard: 1, strong: 2 };
/** Whether a model of this tier is below the least a role needs; an unknown tier is never below. */
export const belowTier = (tier: ModelTier | null, least: ModelTier): boolean => tier !== null && RANK[tier] < RANK[least];
