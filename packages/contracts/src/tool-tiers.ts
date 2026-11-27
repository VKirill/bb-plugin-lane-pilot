export const TOOL_TIERS = ["R", "D", "L", "S"] as const;
export type ToolTier = (typeof TOOL_TIERS)[number];
export const TIER_RANK: Readonly<Record<ToolTier, number>> = { R: 0, D: 1, L: 2, S: 3 };
export const isToolTier = (value: unknown): value is ToolTier =>
  typeof value === "string" && (TOOL_TIERS as readonly string[]).includes(value);
export const REPLAY_POLICIES = ["live", "stubbed", "forbidden"] as const;
export type ReplayPolicy = (typeof REPLAY_POLICIES)[number];
/** R replays live in the sandbox, D with stubbed side effects; L and S are never replayed, only checked on recorded outputs (research R15). */
export const replayPolicy = (tier: ToolTier | undefined): ReplayPolicy | null =>
  tier === undefined ? null : tier === "R" ? "live" : tier === "D" ? "stubbed" : "forbidden";
/** True when a tool of tier `tool` may run inside a step declared `step`. */
export const tierAllows = (step: ToolTier, tool: ToolTier): boolean => TIER_RANK[tool] <= TIER_RANK[step];
