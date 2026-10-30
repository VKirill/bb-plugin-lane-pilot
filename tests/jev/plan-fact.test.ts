import { describe, expect, it } from "vitest";
import { clipDiff, PLAN_FACT_DIFF_CHARS, planFactJudgment } from "../../src/rooms/tasks/plan-fact-judgment";

const input = { acceptance: ["Button has a border", "Existing tests still pass"], diff: "diff --git a/src/a.ts b/src/a.ts\n+border: 1px", checks: [{ command: "npm test", exitCode: 0 }] };

describe("plan.fact judgment", () => {
  it("asks one Noul per acceptance item over the whitelisted state", () => {
    const questions = planFactJudgment.questions(input) as Record<string, { type: string; instructions: string }>;
    expect(Object.keys(questions)).toEqual(["item_1", "item_2"]);
    expect(questions.item_1!.instructions).toContain("Button has a border");
    const state = planFactJudgment.stateBuilder(input) as Record<string, unknown>;
    expect(Object.keys(state)).toEqual(["acceptance", "diff", "checks"]);
    expect(JSON.stringify(state)).not.toContain("task");
  });
  it("maps p(done) to done / not_done / unseen", () => {
    const t = { min_done: 0.6, max_not_done: 0.35 };
    const answers = (a: number, b: number) => ({ item_1: { type: "noul" as const, noul: a }, item_2: { type: "noul" as const, noul: b } });
    expect(planFactJudgment.decide(answers(0.9, 0.1), t, input).decision).toEqual({ items: { 1: "done", 2: "not_done" } });
    expect(planFactJudgment.decide(answers(0.5, 0.9), t, input).decision).toEqual({ items: { 1: "unseen", 2: "done" } });
    expect(planFactJudgment.fallback(input)).toEqual({ items: { 1: "unseen", 2: "unseen" } });
  });
  it("a clipped diff is marked; the fallback answers every item unseen", () => {
    expect(clipDiff("x".repeat(PLAN_FACT_DIFF_CHARS + 10))).toContain("[diff truncated]");
    expect(clipDiff("short")).toBe("short");
  });
});
