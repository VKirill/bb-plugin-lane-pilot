import { choice, choiceOf, defineJudgment, score, type JevAsset } from "@lane-pilot/jev";
import { RUBRIC } from "./logic";

/**
 * Design judged by a judge (SMA map: Design judged by a judge): two pictures, a rubric and grounds go to an independent judge model,
 * which picks the better design. The module is wired into no product path — scripts/lp-design-eval.ts and the design-pair flow
 * call it; a low-confidence pick is a tie decided in code, not by the model.
 */
export const DESIGN_PAIR_ID = "design.pair";

export type DesignPairShot = { format: "png" | "jpg" | "jpeg"; data_base64: string };
export type DesignPairInput = { grounds: string; a: DesignPairShot; b: DesignPairShot; criteria?: string[] };
export type DesignPairDecision = { winner: "a" | "b" | "tie"; p: number; scores: Record<string, number> };
/** Where a verdict came from: the judge in active mode, the judge's shadow answer (its default mode keeps the fallback as the official one), or the code fallback. */
export type DesignPairVerdict = DesignPairDecision & { from: "jev" | "shadow" | "fallback" };

export const designPairJudgment = defineJudgment<DesignPairInput, DesignPairDecision>({
  id: DESIGN_PAIR_ID,
  title: "Судья пар дизайна",
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 25_000,
  stateBuilder: (input) => ({
    rubric: (input.criteria ?? [...RUBRIC]).slice(0, 8),
    grounds: input.grounds.length > 8000 ? `${input.grounds.slice(0, 8000)}…` : input.grounds,
    shots: { a: "design-a-4k9", b: "design-b-4k9" },
  }),
  assets: (input) => ({
    "design-a-4k9": { type: "image", format: input.a.format, data_base64: input.a.data_base64 } satisfies JevAsset,
    "design-b-4k9": { type: "image", format: input.b.format, data_base64: input.b.data_base64 } satisfies JevAsset,
  }),
  questions: (input) => {
    const criteria = input.criteria ?? [...RUBRIC];
    const out: Record<string, ReturnType<typeof choice> | ReturnType<typeof score>> = {
      winner: choice(
        "Two design screenshots, `shots.a` and `shots.b`, judged on the `rubric` criteria with the `grounds` context. Which is the better design overall?",
        { a: "design A is better", b: "design B is better", tie: "neither is better" },
      ),
    };
    for (const criterion of criteria.slice(0, 8)) {
      out[`c_${criterion}`] = score(
        `On the criterion \`${criterion}\`: how much better is design B than design A on the two screenshots?`,
        ["A is much better", "A is better", "equal", "B is better", "B is much better"],
      );
    }
    return out;
  },
  thresholds: {
    tie_p: { default: 0.45, min: 0.2, max: 0.9, about: "below this top probability the pair is a tie, whatever the top choice" },
  },
  decide(answers, t, input) {
    const picked = choiceOf(answers, "winner");
    const scores: Record<string, number> = {};
    for (const criterion of (input.criteria ?? [...RUBRIC]).slice(0, 8)) {
      const answer = answers[`c_${criterion}`];
      scores[criterion] = answer?.type === "score" ? answer.score : 0;
    }
    if (!picked || picked.top === "tie" || picked.p < t.tie_p!) return { decision: { winner: "tie", p: picked?.p ?? 0, scores } };
    return { decision: { winner: picked.top === "b" ? "b" : "a", p: picked.p, scores } };
  },
  fallback: () => ({ winner: "tie", p: 0, scores: {} }),
  describe: (d) => `winner ${d.winner} (p=${d.p})`,
});

type JevPort = { judge(judgment: unknown, input: unknown, ctx: unknown): Promise<{ decision?: DesignPairDecision; status?: string; shadow?: { decision?: DesignPairDecision } }> };

/**
 * The judged pair: a one-call wrapper the design-pair flow and the script use. The judgment's default mode is shadow: the run then
 * returns the fallback (a tie, p 0) and keeps the real verdict in `shadow`, so a shadow run is read from there and marked `from: "shadow"`.
 */
export async function judgeDesigns(jev: JevPort, input: DesignPairInput, ctx: Record<string, unknown> = {}): Promise<DesignPairVerdict> {
  const result = await jev.judge(designPairJudgment, input, ctx);
  if (result.status === "shadow" && result.shadow?.decision) return { ...result.shadow.decision, from: "shadow" };
  if (result.decision && result.status === undefined) return { ...result.decision, from: "jev" };
  return { ...(result.decision ?? designPairJudgment.fallback(input)), from: "fallback" };
}
