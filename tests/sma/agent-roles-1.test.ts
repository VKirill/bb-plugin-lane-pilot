import { describe, expect, it } from "vitest";
import { blindVerdict, type PlanItem, type TaskFact } from "../../src/rooms/phase/logic";

const item = (id: string): PlanItem => ({
  id, title: id, wave: 1, promise: { given: "g", when: "w", then: "t" },
  task: { id, kind: "feature", acceptance: ["the bar stays"], verification: [{ command: "npm test" }] },
});
const fact = (taskId: string, over: Partial<TaskFact> = {}): TaskFact => ({
  taskId, state: "accepted", planFact: "passed", verification: "passed", codeCritique: "passed", ...over,
});

describe("verification roles", () => {
  it("[sma:k_ag_verifier] a closed task whose promise is not proved fails; the same facts freeze one verdict", () => {
    const items = [item("hud")];
    const closed = new Map([["hud", fact("hud", { planFact: "failed" })]]);
    const failed = blindVerdict(items, closed, { state: "passed", headSha: "abc" }, 1);
    expect(failed.state).toBe("failed");
    expect(failed.detail).toContain("plan-fact failed");
    const proved = new Map([["hud", fact("hud")]]);
    const passed = blindVerdict(items, proved, { state: "passed", headSha: "abc" }, 1);
    expect(passed.state).toBe("passed");
    expect(blindVerdict(items, proved, { state: "passed", headSha: "abc" }, 2).inputSha).toBe(passed.inputSha);
    const unaccepted = new Map([["hud", fact("hud", { state: "blocked" })]]);
    expect(blindVerdict(items, unaccepted, { state: "passed" }, 1).detail).toContain("not accepted");
  });

  it.todo("[sma:k_ag_verifier] the verdict is not written to VERIFICATION.md");
  it.todo("[sma:k_ag_executor] the writer brief does not execute PLAN.md, make atomic commits, or write SUMMARY.md");
});
