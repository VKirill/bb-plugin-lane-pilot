import { describe, expect, it } from "vitest";
import { criticScreenJudgment, criticScreenRoute } from "../../src/rooms/critique/critic-screen";

const answers = (top: "pass" | "fail" | "unsure", p: number) => {
  const rest = (1 - p) / 2;
  const probabilities = { pass: rest, fail: rest, unsure: rest, [top]: p };
  return { call: { type: "choice" as const, choice: top, probabilities, confidence: p } };
};

describe("code critic screen", () => {
  it("keeps an obvious pass or fail and sends a close call to the critic", () => {
    const thresholds = { min_p: 0.8 };
    const packet = { packet: "title: x" };
    expect(criticScreenJudgment.decide(answers("pass", 0.91), thresholds, packet)).toEqual({ decision: { call: "pass" } });
    expect(criticScreenJudgment.decide(answers("fail", 0.9), thresholds, packet)).toEqual({ decision: { call: "fail" } });
    expect(criticScreenJudgment.decide(answers("pass", 0.6), thresholds, packet)).toEqual({ escalate: "code-critic" });
    expect(criticScreenJudgment.decide(answers("unsure", 0.95), thresholds, packet)).toEqual({ escalate: "code-critic" });
    expect(criticScreenRoute({ by: "jev", decision: { call: "fail" } })).toBe("fail");
    expect(criticScreenRoute({ by: "escalate", decision: { call: "pass" } })).toBe("llm");
    expect(criticScreenRoute({ by: "fallback", decision: { call: "pass" } })).toBe("llm");
  });
});
