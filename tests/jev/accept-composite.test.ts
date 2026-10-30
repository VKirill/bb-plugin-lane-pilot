import { describe, expect, it } from "vitest";
import { acceptCompositeJudgment } from "@lane-pilot/jev/judgments/accept-composite";

const sc = (v: number) => ({ type: "score" as const, score: v, legend: {}, probabilities: {}, confidence: 0.9 });
const input = { kind: "post", brief: "b", artifact: "text" };

describe("accept.composite", () => {
  it("fails on the weakest axis, names it", () => {
    const d = acceptCompositeJudgment.decide({ brief_fit: sc(3), voice: sc(1), no_slop: sc(3), structure: sc(2) }, { pass_level: 2 }, input);
    expect(d.decision?.pass).toBe(false);
    expect(d.decision?.weakest).toBe("voice");
  });
  it("passes when every axis reaches the level", () => {
    const d = acceptCompositeJudgment.decide({ brief_fit: sc(2), voice: sc(3), no_slop: sc(2), structure: sc(4) }, { pass_level: 2 }, input);
    expect(d.decision?.pass).toBe(true);
    expect(d.decision?.weakest).toBeNull();
  });
  it("whitelist state", () => {
    const state = acceptCompositeJudgment.stateBuilder({ ...input, extra: "drop", artifact: "y".repeat(20000) } as never) as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(["artifact", "axes", "brief", "kind"]);
    expect((state.artifact as string).length).toBeLessThanOrEqual(16001);
  });
});
