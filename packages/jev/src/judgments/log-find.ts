import { choice, choiceOf, defineJudgment, noul, noulOf } from "../registry";

/**
 * The one line of a long log that explains the failure (B8; the line-by-line search cookbook). log-trim decides which
 * chunks survive; this answers *which line to read* — the found line feeds failure.class and the repair diff. Lines are
 * numbered in the state; the answer is a Choice over their ids plus a Noul «the log holds an answer».
 */
export const LOG_FIND_ID = "logs.error_find";
export const MAX_LINES = 48;

export type LogFindInput = { task: string; command: string; lines: string[] };
export type LogFindDecision = { line: number | null; hasAnswer: boolean };

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export const logFindJudgment = defineJudgment<LogFindInput, LogFindDecision>({
  id: LOG_FIND_ID,
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 10_000,
  stateBuilder: (input) => ({
    task: clip(input.task, 300),
    command: clip(input.command, 200),
    lines: Object.fromEntries(input.lines.slice(0, MAX_LINES).map((line, i) => [`l${i}`, clip(line, 400)])),
  }),
  questions: (input) => ({
    answer: noul("`command` ran for `task` and failed; `lines` is its output, numbered l0..lN. Does any single line say what actually failed (a real error, not a warning or a summary line)?",
      { true: "one line identifies the failure", false: "noise, truncated, or only generic failure chatter" }),
    which: choice(
      "Which `lines` entry states the actual failure? Answer its id.",
      Object.fromEntries(input.lines.slice(0, MAX_LINES).map((_, i) => [`l${i}`, `line ${i}`])),
    ),
  }),
  thresholds: { answer_p: { default: 0.6, min: 0.3, max: 0.95, about: "p that the log holds a pointed line" } },
  decide(answers, t, input) {
    const has = (noulOf(answers, "answer") ?? 0) >= t.answer_p!;
    const pick = choiceOf(answers, "which");
    const index = pick ? Number(/^l(\d+)$/.exec(pick.top)?.[1]) : NaN;
    return { decision: { line: has && Number.isInteger(index) && index < input.lines.length ? index : null, hasAnswer: has } };
  },
  fallback: () => ({ line: null, hasAnswer: false }),
  describe: (d) => d.line === null ? "no pointed line" : `line ${d.line}`,
});
