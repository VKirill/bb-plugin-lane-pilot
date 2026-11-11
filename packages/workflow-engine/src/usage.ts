/** What a step spent. `unknown`: the provider reports no usage, so the numbers are a floor, not zero; the run records it per step and holds a token or money budget to a time and step limit. */
export type Usage = { tokens?: number; costUsd?: number; unknown?: boolean };

/** Without usage events a run under a token or money budget stops at this many steps / seconds, unless the budget names its own. */
export const UNKNOWN_USAGE_MAX_WALL_SECONDS = 2 * 3600;

/** Two spends as one: tokens and cost add up, and one unknown part makes the whole unknown. */
export function addSpend(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  return { tokens: (a.tokens ?? 0) + (b.tokens ?? 0), costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0), ...(a.unknown || b.unknown ? { unknown: true } : {}) };
}
