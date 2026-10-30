/**
 * Best-of-3 for quality_mode full (arXiv #18/#19, S* and CodeMonkeys): after two sequential attempts a parallel
 * candidate beats a higher-effort retry. Three writers of the fallback chain run the task at once, each in its own
 * worktree; the winner is picked by the task's checks first and, when the checks leave a tie, by the code critic's
 * verdict. The losers close as superseded and are never merged.
 *
 * Recursive scaling (arXiv #20): `writer.best_of.rounds` above 1 turns the single round into a refinement loop —
 * a candidate of round 2+ starts with the round seed: the previous round's surviving candidates, their diff stats
 * and what their checks said, so the next round iterates on the best instead of starting blank. One round (the
 * default) is the plain best-of; the task's token budget counts candidates × rounds.
 *
 * The cost is bounded by two settings beside the switch:
 *  - `writer.best_of.token_budget`: the most the parallel candidates of one task may spend together (0: the run's
 *    budget alone rules),
 *  - `writer.best_of.slot_cap`: the most attempts of the task in the air at once (a project with one writer slot
 *    runs the three in turn — best-of keeps working, just slower).
 * All three are catalog settings; `writer.best_of` off is the behaviour before this existed.
 */
import { writerFallbackChain, type WriterFallback } from "./writer-fallbacks";
import type { QualityMode } from "../critique";

export const BEST_OF_SETTING = "writer.best_of";
export const BEST_OF_TOKEN_BUDGET_SETTING = "writer.best_of.token_budget";
export const BEST_OF_SLOT_CAP_SETTING = "writer.best_of.slot_cap";
export const BEST_OF_ROUNDS_SETTING = "writer.best_of.rounds";
export const BEST_OF_VALUES = ["off", "3"] as const;
export const BEST_OF_COUNT = 3;
/** A token budget a project did not set: the run's own budget is the only bound. */
export const BEST_OF_TOKEN_BUDGET_DEFAULT = 0;
export const BEST_OF_SLOT_CAP_DEFAULT = 3;
/** One round is the plain best-of; recursion is opt-in. */
export const BEST_OF_ROUNDS_DEFAULT = 1;
export const BEST_OF_ROUNDS_MAX = 4;

export type BestOfPlan = {
  enabled: boolean;
  /** How many parallel candidates a task runs when the mode allows it (BEST_OF_COUNT, or the slot cap when lower). */
  count: number;
  /** The candidates' shared token ceiling; 0 means only the run budget applies. */
  tokenBudget: number;
  /** How many attempts of the task may be in the air at once. */
  slotCap: number;
  /** Refinement rounds: 1 is the plain single-round best-of. */
  rounds: number;
};

const head = (text: string, max: number): string => text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const intSetting = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
};

/** The plan for this task: best-of-3 runs only under quality_mode full with `writer.best_of` = 3; anything else is one attempt. */
export function resolveBestOf(settings: Record<string, unknown>, mode: QualityMode): BestOfPlan {
  const on = mode === "full" && String(settings[BEST_OF_SETTING] ?? "off") === "3";
  const slotCap = intSetting(settings[BEST_OF_SLOT_CAP_SETTING], BEST_OF_SLOT_CAP_DEFAULT, 1, BEST_OF_COUNT);
  const tokenBudget = intSetting(settings[BEST_OF_TOKEN_BUDGET_SETTING], BEST_OF_TOKEN_BUDGET_DEFAULT, 0, 1_000_000_000);
  const rounds = intSetting(settings[BEST_OF_ROUNDS_SETTING], BEST_OF_ROUNDS_DEFAULT, 1, BEST_OF_ROUNDS_MAX);
  return { enabled: on, count: on ? Math.min(BEST_OF_COUNT, slotCap) : 1, tokenBudget, slotCap, rounds: on ? rounds : 1 };
}

/** What a task's appetite counts for in the dispatch spend reserve: one attempt's worth, or three when best-of is on. */
export function reserveAppetite(appetite: number, plan: BestOfPlan): number {
  return appetite * (plan.enabled ? BEST_OF_COUNT * plan.rounds : 1);
}

/** Whether another candidate of the task may start under the candidates' shared token budget (0: always). */
export function bestOfBudgetAllows(plan: BestOfPlan, spentTokens: number): boolean {
  return !plan.enabled || plan.tokenBudget === 0 || spentTokens < plan.tokenBudget;
}

export type WriterPair = { providerId: string; model: string };

/**
 * The writers the candidates run on: the task's own writer, then the fallback chain (fallback 1, fallback 2, fallback 3,
 * the PM's model), no repeats. The chain may be shorter than the count: best-of then runs what it has (a two-entry chain
 * is best-of-2).
 */
export function bestOfPicks(input: { primary: WriterPair; fallbacks: readonly WriterFallback[]; pm: WriterPair; count?: number }): WriterPair[] {
  const count = Math.max(1, Math.min(BEST_OF_COUNT, input.count ?? BEST_OF_COUNT));
  const chain = writerFallbackChain(input.primary, input.fallbacks, input.pm).map((entry) => ({ providerId: entry.providerId, model: entry.model }));
  return [input.primary, ...chain].slice(0, count);
}

export type BestOfCriticVerdict = "pass" | "fail" | null | undefined;
export type BestOfCandidate = {
  attemptId: string;
  /** The task's own checks on this candidate's worktree (validateWriterResult accepted): the first selection key. */
  checksOk: boolean;
  /** The code critic's verdict on the candidate; absent when the tie never needed it. */
  critic?: BestOfCriticVerdict;
  /** What the candidate spent, for the deterministic last tiebreak. */
  tokens?: number | null;
};

const criticRank = (verdict: BestOfCriticVerdict): number => verdict === "pass" ? 2 : verdict === "fail" ? 0 : 1;

/**
 * The winner of a best-of run and the attempts to close as superseded (they are never merged). Selection: the task's
 * checks; a tie of green candidates goes to the critic's verdict (pass beats unread beats fail); a still-tied race goes
 * to the cheaper candidate, then to the earlier one. With no green candidate there is no winner: the task's usual
 * failure path applies, nothing is superseded into the base.
 */
export function pickBestAttempt(candidates: readonly BestOfCandidate[]): { winnerId: string | null; supersededIds: string[] } {
  const green = candidates.filter((candidate) => candidate.checksOk);
  if (!green.length) return { winnerId: null, supersededIds: [] };
  const ranked = green
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) =>
      criticRank(b.candidate.critic) - criticRank(a.candidate.critic)
      || (a.candidate.tokens ?? Number.MAX_SAFE_INTEGER) - (b.candidate.tokens ?? Number.MAX_SAFE_INTEGER)
      || a.index - b.index);
  const winner = ranked[0]!.candidate.attemptId;
  return { winnerId: winner, supersededIds: candidates.map((candidate) => candidate.attemptId).filter((attemptId) => attemptId !== winner) };
}

export type RoundCandidate = {
  attemptId: string;
  /** The attempt's terminal state (`accepted`, `superseded`, `failed`, …); green states seed the next round first. */
  state: string;
  /** Why the attempt ended as it did — the verification remarks when it failed. */
  reason?: string | null;
  /** `git diff --stat` of the candidate's worktree, when it could still be measured. */
  diffStat?: string | null;
};

const STATE_RANK: Record<string, number> = { accepted: 3, superseded: 2 };

/** The survivors of a round — the candidates the next round iterates on: green states first, then by order, top half at most. */
export function roundSurvivors(candidates: readonly RoundCandidate[]): RoundCandidate[] {
  const ranked = [...candidates].sort((a, b) => (STATE_RANK[b.state] ?? 1) - (STATE_RANK[a.state] ?? 1));
  return ranked.slice(0, Math.max(1, Math.ceil(candidates.length / 2)));
}

const SEED_REASON_MAX = 400;
const SEED_STAT_MAX = 800;
export const ROUND_SEED_MAX_CHARS = 6_000;

/**
 * The brief a round-2+ candidate starts with: which attempts of the previous round survived, what their diff did
 * and what their checks said, and the instruction to iterate on the best instead of starting blank. Bounded by
 * ROUND_SEED_MAX_CHARS.
 */
export function roundSeedBrief(round: number, rounds: number, survivors: readonly RoundCandidate[]): string {
  const lines = [
    `Best-of round ${round} of ${rounds}: the strongest candidates of round ${round - 1} and what their checks said. Iterate on their direction; do not start from a blank page.`,
  ];
  for (const candidate of survivors) {
    lines.push(`- attempt ${candidate.attemptId}: ${candidate.state}${candidate.reason ? ` — ${head(candidate.reason, SEED_REASON_MAX)}` : ""}`);
    if (candidate.diffStat) lines.push(`  diff: ${head(candidate.diffStat.replace(/\n/g, "; "), SEED_STAT_MAX)}`);
  }
  let brief = lines.join("\n");
  if (brief.length > ROUND_SEED_MAX_CHARS) brief = `${brief.slice(0, ROUND_SEED_MAX_CHARS - 1)}…`;
  return brief;
}
