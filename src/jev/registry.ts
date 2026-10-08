import type { JevAnswer, JevQuestion } from "./types";

/**
 * A named judgment: what is sent (state and questions), how the answers become a decision (`decide`, pure and unit-tested), the
 * thresholds that decision reads, and the deterministic answer when Jev cannot be asked (`fallback`, synchronous, the behaviour
 * the code had before). Nothing outside the registry builds a request by hand.
 *
 * Decisions use `probabilities` (a Noul value, the top probability and the margin of a Choice). `confidence` is recorded in the
 * receipt but never gates: it is not the probability of the chosen answer (a yes of 0.51 had confidence 0.03).
 */
export const MAX_QUESTIONS_PER_JUDGMENT = 48;
export type JudgmentMode = "off" | "shadow" | "active";

export type ThresholdSpec = { default: number; min: number; max: number; about: string };
export type Thresholds = Record<string, number>;

export type Answers = Record<string, JevAnswer>;

/** What `decide` returns: a decision, or the wish to hand the case to a stronger (slower) judge. */
export type Decided<D> = { escalate: string; decision?: undefined } | { decision: D; escalate?: undefined };

export type Judgment<I, D> = {
  id: string;
  /** Raise it when the questions or the decision rule change: receipts of different versions are not comparable. */
  version: number;
  /** A pinned model for tuning thresholds; `jev-latest` when not set. */
  model?: string;
  /** The mode when the project does not set one: a new judgment starts in `shadow`. */
  defaultMode: JudgmentMode;
  timeoutMs: number;
  /** Only what the questions need, already redacted. The receipt keeps its hash and size, never the text. */
  stateBuilder(input: I): unknown;
  questions(input: I): Record<string, JevQuestion>;
  thresholds: Record<string, ThresholdSpec>;
  decide(answers: Answers, thresholds: Thresholds, input: I): Decided<D>;
  fallback(input: I): D;
  /** A short text for the receipt: the decision in a few words. */
  describe(decision: D): string;
};

const judgments = new Map<string, Judgment<any, any>>();

export function defineJudgment<I, D>(judgment: Judgment<I, D>): Judgment<I, D> {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(judgment.id)) throw new Error(`judgment id "${judgment.id}": use area.name in lowercase`);
  if (judgments.has(judgment.id) && judgments.get(judgment.id) !== judgment) throw new Error(`judgment "${judgment.id}" is defined twice`);
  judgments.set(judgment.id, judgment);
  return judgment;
}

export const getJudgment = (id: string): Judgment<any, any> | undefined => judgments.get(id);
export const listJudgments = (): Array<Judgment<any, any>> => [...judgments.values()].sort((a, b) => a.id.localeCompare(b.id));

export const choice = (instructions: unknown, criteria: Record<string, unknown>): JevQuestion => ({ type: "choice", instructions, criteria });
export const noul = (instructions: unknown, criteria?: { true?: unknown; false?: unknown }): JevQuestion => ({ type: "noul", instructions, ...(criteria ? { criteria } : {}) });
export const score = (instructions: unknown, criteria: unknown[]): JevQuestion => ({ type: "score", instructions, criteria });

/** The probability of a Noul, or `undefined` when the answer is not one. */
export const noulOf = (answers: Answers, id: string): number | undefined => {
  const answer = answers[id];
  return answer?.type === "noul" ? answer.noul : undefined;
};

/** A Choice as the code needs it: options sorted by probability, with the top one and its margin over the second. */
export function choiceOf(answers: Answers, id: string): { top: string; p: number; second: string | null; margin: number; ranked: Array<[string, number]> } | undefined {
  const answer = answers[id];
  if (answer?.type !== "choice") return undefined;
  const ranked = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]);
  const [top, runnerUp] = ranked;
  if (!top) return undefined;
  return { top: top[0], p: top[1], second: runnerUp?.[0] ?? null, margin: top[1] - (runnerUp?.[1] ?? 0), ranked };
}
