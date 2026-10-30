import { defineJudgment, noul, noulOf } from "../registry";

/**
 * Is this workflow step trivial enough for a cheaper model (architecture audit №9)? The caller applies the answer only
 * in `active` mode and only to roles that are allowed to downgrade (a code writer never goes below its tier, judges and
 * critics never downgrade, high/critical-risk steps never).
 */
export const STEP_TRIVIAL_ID = "graph.step_trivial";

export type StepTrivialInput = { nodeType: string; role: string; inputChars: number; risk?: string };
export type StepTrivialDecision = { trivial: boolean };

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export const stepTrivialJudgment = defineJudgment<StepTrivialInput, StepTrivialDecision>({
  id: STEP_TRIVIAL_ID,
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 8_000,
  stateBuilder: (input) => ({
    node: clip(input.nodeType, 40),
    role: clip(input.role, 80),
    input_chars: Math.min(Math.trunc(input.inputChars) || 0, 9_999_999),
    ...(input.risk ? { risk: clip(input.risk, 20) } : {}),
  }),
  questions: () => ({
    trivial: noul(
      "`role` is the workflow step's helper role, `node` its node type, `input_chars` the size of its input. Is this step trivial — mechanical, short, needing no judgment (a format change, a copy, a list read, a rename)?",
      { true: "a light model finishes it as well", false: "real judgment or craft; a lighter model would visibly do worse" },
    ),
  }),
  thresholds: { trivial_p: { default: 0.8, min: 0.5, max: 0.98, about: "p(trivial) needed to downgrade the step's model" } },
  decide: (answers, t) => ({ decision: { trivial: (noulOf(answers, "trivial") ?? 0) >= t.trivial_p! } }),
  fallback: () => ({ trivial: false }),
  describe: (d) => (d.trivial ? "trivial" : "keep"),
});
