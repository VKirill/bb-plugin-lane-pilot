import { describe, expect, it } from "vitest";
import { loadWorkflow } from "@lane-pilot/workflow-engine";
import { codes, workflow } from "./fixtures";

function agentChain(agentOverrides: Record<string, unknown>) {
  return workflow({
    nodes: [
      {
        id: "work",
        type: "agent",
        role: "analyst",
        prompt: "Analyze {{input.query}}",
        out: [{ name: "res", type: "string" }],
        ...agentOverrides,
      },
      { id: "done", type: "action", action: "emit", map: { result: "work.res" } },
    ],
    edges: [
      { from: "start", to: "work" },
      { from: "work", to: "done" },
    ],
  });
}

describe("Task 22: instruction budget warnings", () => {
  it("warns plan_over_budget on 11 plan steps and not on 10", () => {
    const ten = loadWorkflow(agentChain({
      form: "plan",
      plan: { steps: Array.from({ length: 10 }, (_, i) => `Step ${i + 1}`) },
    }));
    expect(ten.ok).toBe(true);
    if (ten.ok) {
      expect(codes(ten.warnings, "warning")).not.toContain("plan_over_budget");
    }

    const eleven = loadWorkflow(agentChain({
      form: "plan",
      plan: { steps: Array.from({ length: 11 }, (_, i) => `Step ${i + 1}`) },
    }));
    expect(eleven.ok).toBe(true);
    if (eleven.ok) {
      const warning = eleven.warnings.find((w) => w.code === "plan_over_budget");
      expect(warning).toMatchObject({ level: "warning", code: "plan_over_budget", node: "work" });
      expect(warning?.message).toContain("work");
      expect(warning?.message).toContain("split into nodes");
    }

    const stringOver = loadWorkflow(agentChain({
      form: "plan",
      plan: Array.from({ length: 11 }, (_, i) => `${i + 1}. Step ${i + 1}`).join("\n"),
    }));
    expect(stringOver.ok).toBe(true);
    if (stringOver.ok) {
      expect(codes(stringOver.warnings, "warning")).toContain("plan_over_budget");
    }
  });

  it("warns prompt_over_budget on 101 non-empty prompt lines and ignores blank lines", () => {
    const hundredWithBlanks = loadWorkflow(agentChain({
      prompt: [
        ...Array.from({ length: 100 }, (_, i) => `Rule ${i + 1}`),
        "",
        "   ",
        "\t",
      ].join("\n"),
    }));
    expect(hundredWithBlanks.ok).toBe(true);
    if (hundredWithBlanks.ok) {
      expect(codes(hundredWithBlanks.warnings, "warning")).not.toContain("prompt_over_budget");
    }

    const hundredOne = loadWorkflow(agentChain({
      prompt: Array.from({ length: 101 }, (_, i) => `Rule ${i + 1}`).join("\n"),
    }));
    expect(hundredOne.ok).toBe(true);
    if (hundredOne.ok) {
      const warning = hundredOne.warnings.find((w) => w.code === "prompt_over_budget");
      expect(warning).toMatchObject({ level: "warning", code: "prompt_over_budget", node: "work" });
      expect(warning?.message).toContain("work");
      expect(warning?.message).toContain("split into nodes");
    }
  });
});
