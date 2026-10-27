import { describe, expect, it } from "vitest";
import { taskV2Schema } from "../../src/rooms/contracts";
import { shouldRunPlanCritique } from "../../src/rooms/critique/critique";
import { parseCodeCritiqueSettings } from "../../src/rooms/critique/code-critique";
import { applyQualityMode, browserQaRequired, resolveQualityMode, taskQaPlan } from "../../src/rooms/critique/quality-mode";
import { validateTaskV2 } from "../../src/rooms/tasks/task-v2";

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

describe("the task contract carries qa_url, qa_env_class and qa_dev_server, all optional", () => {
  it("accepts an http(s) page, a known class and a dev-server command; refuses the rest", () => {
    expect(validateTaskV2({ ...base, qa_cases: ["x"], qa_url: "http://127.0.0.1:5173/cart", qa_env_class: "local", qa_dev_server: "npm run dev" }).ok).toBe(true);
    expect(validateTaskV2({ ...base, qa_url: "file:///etc/passwd" }).ok).toBe(false);
    expect(validateTaskV2({ ...base, qa_url: "http://a b" }).ok).toBe(false);
    expect(validateTaskV2({ ...base, qa_env_class: "moon" }).ok).toBe(false);
    expect(validateTaskV2({ ...base, qa_dev_server: "" }).ok).toBe(false);
  });
});

describe("taskQaPlan: what the task's graph runs as its browser check", () => {
  it("is null without both qa_cases and qa_url, in any mode", () => {
    expect(taskQaPlan(null)).toBeNull();
    expect(taskQaPlan({})).toBeNull();
    expect(taskQaPlan({ qa_cases: ["x"] })).toBeNull();
    expect(taskQaPlan({ qa_cases: [], qa_url: "http://127.0.0.1/" })).toBeNull();
    expect(taskQaPlan({ qa_url: "http://127.0.0.1/" })).toBeNull();
  });
  it("takes the class from the task, else local for a loopback page and unknown for any other", () => {
    expect(taskQaPlan({ qa_cases: ["x"], qa_url: "http://localhost:3000/a" })).toEqual({ url: "http://localhost:3000/a", cases: ["x"], envClass: "local", devServer: "" });
    expect(taskQaPlan({ qa_cases: ["x"], qa_url: "https://shop.test/a" })?.envClass).toBe("unknown");
    expect(taskQaPlan({ qa_cases: ["x"], qa_url: "https://shop.test/a", qa_env_class: "staging", qa_dev_server: "npm run dev" })).toMatchObject({ envClass: "staging", devServer: "npm run dev" });
  });
});
