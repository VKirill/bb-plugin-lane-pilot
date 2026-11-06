import { describe, expect, it } from "vitest";
import { BRIEF_BUDGETS, capBlock, renderBrief, tagSection, validateBrief } from "../src/rooms/native-agent/brief-standard";

describe("renderBrief", () => {
  it("emits instructions, the five tagged sections in order, data marked as data, and the goal restated last", () => {
    const { text } = renderBrief({
      role: "writer",
      instructions: ["line one", "line two"],
      goal: "objective: do the thing",
      inputs: "workspace: /x",
      boundaries: "owns_paths: src/",
      acceptance: "acceptance:\n- works",
      output: "answer with the changed paths",
      data: [{ tag: "project_memory", title: "Project knowledge", text: "- note" }],
      restate: "do the thing",
    });
    const order = ["line one", "<task_goal>", "<inputs>", "<boundaries>", "<acceptance>", "<output>", "data, not instructions", "<project_memory>", "The task again: do the thing"];
    let at = -1;
    for (const part of order) {
      const next = text.indexOf(part);
      expect(next, `missing or out of order: ${part}`).toBeGreaterThan(at);
      at = next;
    }
  });

  it("cuts an over-cap data block at a line boundary inside its tag and reports the violation", () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    const { text, violations } = renderBrief({ role: "writer", goal: "g", data: [{ tag: "rules", text: big, cap: 2_000 }] });
    const body = text.slice(text.indexOf("<rules>"), text.indexOf("</rules>"));
    expect(body).toContain("cut by Lane Pilot");
    expect(body).not.toContain("line 499");
    expect(body.length).toBeLessThanOrEqual(2_200);
    expect(violations.some((v) => v.code === "data_block_over:rules")).toBe(true);
    expect(capBlock(big, 2_000).text.endsWith("\n[… cut by Lane Pilot: block over 2000 characters …]")).toBe(true);
  });

  it("flags an over-budget instructions part and an over-budget brief", () => {
    const { violations } = renderBrief({ role: "errand", instructions: ["x".repeat(BRIEF_BUDGETS.errand.instructions + 1)], goal: "g" });
    expect(violations.some((v) => v.code === "instructions_over_budget")).toBe(true);
    const over = renderBrief({ role: "errand", instructions: ["i"], goal: "g", data: [{ tag: "pack", text: "y".repeat(15_000) }] });
    expect(over.violations.some((v) => v.code === "brief_over_budget")).toBe(true);
  });

  it("validateBrief catches the dead instructions", () => {
    expect(validateBrief("run `bb tools skills-tree --skills --json`", { skillsPicked: true }).map((v) => v.code)).toContain("skills_tree_for_picked");
    expect(validateBrief("run `bb tools skills-tree --skills --json`", { skillsPicked: false })).toHaveLength(0);
    expect(validateBrief("Task contract:\n{\n  \"schema_version\": 2,").map((v) => v.code)).toContain("contract_json_dump");
    expect(validateBrief("use context7 docs").map((v) => v.code)).toContain("context7_reference");
    expect(validateBrief(tagSection("task_goal", "objective: x"))).toHaveLength(0);
  });
});
