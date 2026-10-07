/**
 * The shapes of the TypeSafe System One API (https://docs.typesafe.ai/api.md): a request is a state and a map of typed
 * questions; the answer to each question carries probabilities, never an explanation.
 */
export type JevChoiceQuestion = { type: "choice"; instructions: unknown; criteria: Record<string, unknown> };
export type JevNoulQuestion = { type: "noul"; instructions: unknown; criteria?: { true?: unknown; false?: unknown } };
export type JevScoreQuestion = { type: "score"; instructions: unknown; criteria: unknown[] };
export type JevQuestion = JevChoiceQuestion | JevNoulQuestion | JevScoreQuestion;

export type JevChoiceAnswer = { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };
/** A Noul is one probability of yes; it has no confidence (the docs: the probability already carries the uncertainty). */
export type JevNoulAnswer = { type: "noul"; noul: number };
export type JevScoreAnswer = { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number };
export type JevAnswer = JevChoiceAnswer | JevNoulAnswer | JevScoreAnswer;

export type JevUsage = { input_tokens: number; output_tokens: number };

/** Why a request did not produce answers. `disabled` is no key or the feature switched off; `budget` is the per-run request budget. */
export type JevFailure = "disabled" | "timeout" | "error" | "breaker_open" | "budget" | "invalid";

export type JevCallResult =
  | { ok: true; answers: Record<string, JevAnswer>; model: string; usage: JevUsage; latencyMs: number; attempts: number }
  | { ok: false; status: JevFailure; error: string; latencyMs: number; attempts: number };

/** A run-wide cap on requests (`jev.max_calls_per_run`); one object per run, shared by every judgment of it. */
export type JevBudget = { remaining: number };

/** Per-question summary stored in a receipt: the pick, the top of the distribution and the confidence, never the state. */
export type AnswerSummary = { kind: "choice" | "noul" | "score"; value: string | number; top: Array<[string, number]>; confidence?: number };
