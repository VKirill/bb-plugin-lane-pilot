import { describe, expect, it } from "vitest";
import { worthOutcome } from "../../src/rooms/critique/critique-worth";

describe("the label the plan critique puts on a critique.worth receipt", () => {
  it("agrees when the critic behaved as Jev predicted, disagrees otherwise, and keeps the facts in the suffix", () => {
    expect(worthOutcome("skip pm_read,plan_critique,specialist_review", false)).toBe("disagree:skip_plan_critique:blocked");
    expect(worthOutcome("skip pm_read,plan_critique,specialist_review", true)).toBe("agree:skip_plan_critique:allowed");
    expect(worthOutcome("all critics", false)).toBe("agree:run_plan_critique:blocked");
    expect(worthOutcome("skip pm_read", true)).toBe("disagree:run_plan_critique:allowed");
    // No shadow verdict (Jev off, an escalation): the fallback kept every critic.
    expect(worthOutcome(undefined, true)).toBe("disagree:run_plan_critique:allowed");
  });
});
