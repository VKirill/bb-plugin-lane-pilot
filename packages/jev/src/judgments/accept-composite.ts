import { defineJudgment, score } from "../registry";

/**
 * Composite acceptance of a non-code deliverable (B9; the composite-scoring pattern): instead of one pass/fail LLM step
 * or one threshold like `ru_score < 7`, the artifact gets one Score per axis the brief declares, the caller combines
 * them in code — rework is addressed by axis («voice», not «everything is bad»).
 */
export const ACCEPT_COMPOSITE_ID = "accept.composite";

export const AXES = ["brief_fit", "voice", "no_slop", "structure"] as const;
export type AcceptAxis = (typeof AXES)[number];
export type AcceptInput = { kind: string; brief: string; artifact: string; axes?: AcceptAxis[] };
export type AcceptDecision = { scores: Record<AcceptAxis, number>; weakest: AcceptAxis | null; pass: boolean };

const LEVELS = [
  "Fails the axis plainly — the artifact must be reworked on it.",
  "Weak — noticeable problems on this axis.",
  "Acceptable.",
  "Good.",
  "Excellent on this axis.",
];
const ASK: Record<AcceptAxis, string> = {
  brief_fit: "Does `artifact` deliver what `brief` asks — the right content, all required points, nothing substituted?",
  voice: "Does `artifact` sound like the author and register the brief names (not generic corporate or AI slop voice)?",
  no_slop: "Is `artifact` free of stock phrasing, filler and neural-slop markers?",
  structure: "Is `artifact` structured for its format — headings, flow, markup limits for the target surface?",
};

export const acceptCompositeJudgment = defineJudgment<AcceptInput, AcceptDecision>({
  id: ACCEPT_COMPOSITE_ID,
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 12_000,
  stateBuilder: (input) => ({
    kind: input.kind.slice(0, 40),
    brief: input.brief.slice(0, 2000),
    artifact: input.artifact.length > 16_000 ? `${input.artifact.slice(0, 16_000)}…` : input.artifact,
    axes: (input.axes ?? [...AXES]).slice(0, 8),
  }),
  questions: (input) => Object.fromEntries((input.axes ?? [...AXES]).slice(0, 8).map((axis) => [
    axis,
    score(`\`artifact\` is a \`kind\` produced for \`brief\`. ${ASK[axis]}`, LEVELS),
  ])),
  thresholds: {
    pass_level: { default: 2, min: 1, max: 4, about: "the score level each axis must reach (0-based levels)" },
  },
  decide(answers, t, input) {
    const axes = (input.axes ?? [...AXES]).slice(0, 8);
    const scores = {} as Record<AcceptAxis, number>;
    let weakest: AcceptAxis | null = null, low = Infinity;
    for (const axis of axes) {
      const answer = answers[axis];
      const value = answer?.type === "score" ? answer.score : 0;
      scores[axis] = value;
      if (value < low) { low = value; weakest = axis; }
    }
    const pass = axes.every((axis) => scores[axis] >= t.pass_level!);
    return { decision: { scores, weakest: pass ? null : weakest, pass } };
  },
  fallback: () => ({ scores: {} as Record<AcceptAxis, number>, weakest: null, pass: true }),
  describe: (d) => d.pass ? "pass" : `rework: ${d.weakest}`,
});
