import { describe, expect, it } from "vitest";
import { taskV2Schema } from "../../src/contracts";
import { shouldRunPlanCritique } from "../../src/stages/critique";
import { parseCodeCritiqueSettings } from "../../src/stages/code-critique";
import { applyQualityMode, browserQaRequired, resolveQualityMode } from "../../src/stages/quality-mode";
import { validateTaskV2 } from "../../src/task-v2";

const base = {
  schema_version: 2, id: "t", title: "T", risk: "low", lane: "writer", project_cwd: "/w", read_first: [], interfaces: [], invariants: [], out_of_scope: [],
  expected_outputs: ["a.txt"], owns_paths: ["a.txt"], never_touch: [], depends_on: [], objective: "o", acceptance: ["a"], verify: "none", verification: [],
};

describe("quality_mode resolution", () => {
  it("is standard when nothing is set, the project's value when it is, and the task's own over both", () => {
    expect(resolveQualityMode({}, undefined)).toBe("standard");
    expect(resolveQualityMode(undefined, null)).toBe("standard");
    expect(resolveQualityMode({}, "full")).toBe("full");
    expect(resolveQualityMode({ quality_mode: "quick" }, "full")).toBe("quick");
    expect(resolveQualityMode({}, "extreme")).toBe("standard");
    expect(resolveQualityMode({ quality_mode: "extreme" }, "quick")).toBe("quick");
  });
});

describe("which stages each mode runs", () => {
  const defaults: Record<string, unknown> = { "plan_critique.min_score": "7" };

  it("standard changes nothing: the settings come back as they are", () => {
    expect(applyQualityMode(defaults, "standard")).toBe(defaults);
    expect(parseCodeCritiqueSettings(applyQualityMode({}, "standard")).enabled).toBe(false);
  });

  it("quick: no plan critique, no code critique, even when the project enabled them", () => {
    const quick = applyQualityMode({ "code_critique.enabled": true, "plan_critique.enabled": true }, "quick");
    expect(quick["plan_critique.enabled"]).toBe(false);
    expect(parseCodeCritiqueSettings(quick).enabled).toBe(false);
  });

  it("full: plan critique on every task whatever its risk, and code critique on", () => {
    const full = applyQualityMode({ "plan_critique.enabled": false, "plan_critique.min_score": "7", "code_critique.enabled": false }, "full");
    expect(parseCodeCritiqueSettings(full).enabled).toBe(true);
    expect(full["plan_critique.enabled"]).toBe(true);
    expect(shouldRunPlanCritique({ taskRisk: "low", tasks: [{ lane: "writer" }], minScore: full["plan_critique.min_score"] }).run).toBe(true);
    expect(shouldRunPlanCritique({ taskRisk: "low", tasks: [{ lane: "writer" }], minScore: defaults["plan_critique.min_score"] }).run).toBe(false);
  });

  it("keeps the project's other settings", () => {
    expect(applyQualityMode({ "code_critique.mode": "advisory", "code_critique.max_rounds": 2 }, "full")).toMatchObject({ "code_critique.mode": "advisory", "code_critique.max_rounds": 2 });
  });

  it("a browser check is required only in full mode, for a task with qa_cases", () => {
    expect(browserQaRequired("full", { qa_cases: ["the cart opens"] })).toBe(true);
    expect(browserQaRequired("full", {})).toBe(false);
    expect(browserQaRequired("full", { qa_cases: [] })).toBe(false);
    expect(browserQaRequired("standard", { qa_cases: ["x"] })).toBe(false);
    expect(browserQaRequired("quick", { qa_cases: ["x"] })).toBe(false);
  });
});

describe("the task contract carries quality_mode and qa_cases, both optional", () => {
  it("an old contract without them is as valid as before", () => {
    expect(taskV2Schema.safeParse(base).success).toBe(true);
    expect(validateTaskV2(base).ok).toBe(true);
  });

  it("accepts a known mode and the cases, rejects an unknown mode", () => {
    expect(validateTaskV2({ ...base, quality_mode: "full", qa_cases: ["the cart opens at 375"] }).ok).toBe(true);
    expect(validateTaskV2({ ...base, quality_mode: "extreme" }).ok).toBe(false);
    expect(validateTaskV2({ ...base, qa_cases: [""] }).ok).toBe(false);
  });
});
