import { describe, expect, it } from "vitest";
import { citationCheckJudgment } from "@lane-pilot/jev/judgments/citation-check";

const input = { claim: "X grew 40%", sourceTitle: "T", sourceUrl: "https://x", excerpt: "report" };
const c = (top: string, probs: Record<string, number>) => ({ type: "choice" as const, choice: top, probabilities: probs, confidence: 0.9 });
const n = (v: number) => ({ type: "noul" as const, noul: v });

describe("research.citation", () => {
  it("supports only when strong and not hallucinated", () => {
    const yes = citationCheckJudgment.decide({ supports: c("supports", { supports: 0.8, partial: 0.1, unsupported: 0.05, absent: 0.05 }), hallucinated: n(0.1) }, { keep_p: 0.6 }, input);
    expect(yes.decision).toEqual({ verdict: "supports", keep: true });
    const hall = citationCheckJudgment.decide({ supports: c("supports", { supports: 0.8 }), hallucinated: n(0.9) }, { keep_p: 0.6 }, input);
    expect(hall.decision?.verdict).not.toBe("supports");
  });
  it("absent and partial map to their classes", () => {
    const absent = citationCheckJudgment.decide({ supports: c("absent", { absent: 0.7, partial: 0.2 }), hallucinated: n(0.5) }, { keep_p: 0.6 }, input);
    expect(absent.decision).toEqual({ verdict: "absent", keep: false });
    const partial = citationCheckJudgment.decide({ supports: c("partial", { partial: 0.6, supports: 0.3 }), hallucinated: n(0.2) }, { keep_p: 0.6 }, input);
    expect(partial.decision).toEqual({ verdict: "partial", keep: true });
  });
  it("stateBuilder whitelists fields and clips long text", () => {
    const state = citationCheckJudgment.stateBuilder({ ...input, excerpt: "y".repeat(20000), extra: "drop" } as never) as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(["claim", "excerpt", "question", "quote", "source"]);
    expect((state.excerpt as string).length).toBeLessThanOrEqual(12000);
  });
});
