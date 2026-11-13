export type ModeratorVerdict = "continue" | "synthesize";

export type ModeratorState = {
  round: number;
  maxRounds: number;
  /** Share of terms in the last round that earlier rounds did not contain, 0..1. */
  novelty: number;
  /** Seats that answered PASS in the last round. */
  passed: number;
  seats: number;
};

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) ?? []);
}

/** How much of the last round is new: terms that no earlier round used, over the round's terms. */
export function roundNovelty(earlier: readonly string[], last: readonly string[]): number {
  const known = tokens(earlier.join("\n"));
  const fresh = tokens(last.join("\n"));
  if (fresh.size === 0) return 0;
  let added = 0;
  for (const term of fresh) if (!known.has(term)) added += 1;
  return added / fresh.size;
}

export const NOVELTY_FLOOR = 0.15;

/** The rule that never hangs: rounds are capped, a round that repeats itself or where most seats pass ends the discussion. */
export function moderatorDecision(state: ModeratorState): ModeratorVerdict {
  if (state.round >= state.maxRounds) return "synthesize";
  if (state.seats > 0 && state.passed >= Math.ceil(state.seats / 2)) return "synthesize";
  if (state.round > 1 && state.novelty < NOVELTY_FLOOR) return "synthesize";
  return "continue";
}

export async function moderate(state: ModeratorState): Promise<{ verdict: ModeratorVerdict; by: "rule" }> {
  return { verdict: moderatorDecision(state), by: "rule" };
}
