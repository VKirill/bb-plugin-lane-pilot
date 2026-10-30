import { describe, expect, it } from "vitest";
import { stepTrivialJudgment } from "@lane-pilot/jev/judgments/step-trivial";
import { downgradableRole } from "../src/rooms/workflow/server/workflow-agent";
import { modelTier, ROLE_MODEL_OPTIONS } from "@lane-pilot/models";

const n = (v: number) => ({ type: "noul" as const, noul: v });

describe("graph.step_trivial", () => {
  it("trivial only above the bar; fallback keeps", () => {
    expect(stepTrivialJudgment.decide({ trivial: n(0.9) }, { trivial_p: 0.8 }, { nodeType: "agent", role: "errand", inputChars: 100 }).decision?.trivial).toBe(true);
    expect(stepTrivialJudgment.decide({ trivial: n(0.5) }, { trivial_p: 0.8 }, { nodeType: "agent", role: "errand", inputChars: 100 }).decision?.trivial).toBe(false);
    expect(stepTrivialJudgment.fallback({ nodeType: "agent", role: "x", inputChars: 0 }).trivial).toBe(false);
  });
  it("whitelist state: only node/role/input_chars/risk", () => {
    const state = stepTrivialJudgment.stateBuilder({ nodeType: "agent", role: "r", inputChars: 100, risk: "high", secret: "SEKRET" } as never) as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(["input_chars", "node", "risk", "role"]);
    expect(JSON.stringify(state)).not.toContain("SEKRET");
  });
});

describe("downgrade guard", () => {
  it("judges, planner, pm never downgrade; a code writer is not a table row", () => {
    for (const role of ["code-critic", "plan-critic", "specialist-reviewer", "auditor", "council", "debugger", "triager", "rules-analyzer", "planner", "pm"]) {
      expect(downgradableRole(role), role).toBe(false);
    }
    expect(downgradableRole("writer")).toBe(false);
    expect(downgradableRole("specialist:3d-artist")).toBe(true);
    expect(downgradableRole("errand")).toBe(true);
  });
  it("one tier cheaper exists for sonnet/sol inside the same provider", () => {
    const RANK: Record<string, number> = { light: 0, standard: 1, strong: 2 };
    const cheaper = (m: string) => { const cur = ROLE_MODEL_OPTIONS.find((x) => x.id === m)!; return ROLE_MODEL_OPTIONS.find((o) => o.providerId === cur.providerId && RANK[o.tier] === RANK[cur.tier] - 1); };
    expect(cheaper("claude-sonnet-5-5")?.id).toBe("claude-haiku-5-5");
    expect(cheaper("gpt-6.1-sol")?.id).toBe("gpt-6.1-terra");
    expect(cheaper("claude-haiku-5-5")).toBeUndefined();
  });
});
