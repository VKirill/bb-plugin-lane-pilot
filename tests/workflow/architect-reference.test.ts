import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROLE_PROFILES } from "../../src/rooms/native-agent/helper-context";
import { WORKFLOW_ARCHITECT_SESSION } from "../../src/rooms/workflow/workflow-architect";
import { PURE_ACTION_KEYS } from "@lane-pilot/workflow-engine";
import { WORKFLOW_REFERENCE } from "@lane-pilot/workflow-engine";
import { PRESET_SLUGS } from "@lane-pilot/models";
import { nodeSchema, workflowSchema } from "@lane-pilot/workflow-engine";
import { DELEGATED_ACTIONS } from "../../src/rooms/workflow/server/workflow-step-executors";
import { resolveAgentModel } from "../../src/rooms/workflow/server/workflow-agent-model";
import { roleSpec } from "../../src/rooms/workflow/server/workflow-agent";

// Instructions audit 2026-10-08: the architect had no list of roles, actions or presets, and its text named an action as «without an executor»
// that had one. The reference is what the tool returns on demand; these pins keep it equal to the code it describes.
const reference = JSON.stringify(WORKFLOW_REFERENCE);

describe("the workflow reference the architect reads", () => {
  it("names every node type of the format", () => {
    const types = nodeSchema.options.map((option) => option.shape.type.value as string);
    for (const type of types) expect(Object.keys(WORKFLOW_REFERENCE.nodeTypes), type).toContain(type);
  });

  it("lists every action that has an executor, and every model preset", () => {
    for (const key of [...PURE_ACTION_KEYS, ...DELEGATED_ACTIONS, "fs.write", "git.diff_files", "lp.state_probe", "lp.run_status", "lp.run_close", "lp.lint_contract", "lp.integration_gate_status"]) expect(reference, key).toContain(key);
    for (const slug of PRESET_SLUGS) expect(reference, slug).toContain(slug);
  });

  it("names every trigger type", () => {
    const shape = workflowSchema.shape.triggers.def.innerType.element.shape;
    for (const type of shape.type.options) expect(WORKFLOW_REFERENCE.triggers, type).toContain(type);
  });

  it("says what the roles can reach, as the code gives it", () => {
    // The default role is read-only analysis; the browser and the accounts are the errand's.
    expect(roleSpec("worker").helper).toBe("analyst");
    expect(ROLE_PROFILES.analyst.bbPlugins).toEqual([]);
    expect(roleSpec("errand").helper).toBe("errand");
    expect(ROLE_PROFILES.errand.bbPlugins).toEqual(expect.arrayContaining(["browser-automation", "env-catalog"]));
    expect(roleSpec("errand").readOnly).toBe(true);
    expect(roleSpec("project-life").readOnly).toBe(false);
    expect(roleSpec("specialist:tavily").readOnly).toBe(false);
  });

  it("states the model precedence in the order the resolver applies it", () => {
    const settings = { "pm_read.provider": "stage-p", "pm_read.model": "stage-m", "workflow.agent.provider": "agent-p", "workflow.agent.model": "agent-m" };
    const pm = { providerId: "pm-p", model: "pm-m" };
    const pick = (node: object, set: Record<string, unknown>) => resolveAgentModel({ role: "analyst", node, settings: set, pm }).source;
    expect(pick({ model_preset: "cheap-fast" }, settings)).toBe("preset");
    expect(pick({}, settings)).toBe("stage");
    expect(pick({}, { "workflow.agent.provider": "agent-p", "workflow.agent.model": "agent-m" })).toBe("agent");
    expect(pick({}, {})).toBe("pm");
    expect(pick({ provider: "p", model: "m" }, settings)).toBe("node");
    const text = WORKFLOW_REFERENCE.models.precedence;
    expect(text.indexOf("model_preset")).toBeLessThan(text.indexOf("stage selection"));
    expect(text.indexOf("stage selection")).toBeLessThan(text.indexOf("workflow.agent"));
    expect(text.indexOf("workflow.agent")).toBeLessThan(text.indexOf("PM chat"));
  });

  it("keeps the architect's own text in line with it", () => {
    for (const phrase of ["role: \"errand\"", "model_preset", "expect_status", "sections: [\"reference\"]", "cheap-fast", "schedule", "telegram"]) expect(WORKFLOW_ARCHITECT_SESSION, phrase).toContain(phrase);
    // telegram.send_rich has an executor (it runs in an errand helper): it is not the example of an action that has none.
    expect(WORKFLOW_ARCHITECT_SESSION).not.toMatch(/telegram\.send_rich[^.]*no executor/);
    expect(WORKFLOW_ARCHITECT_SESSION).not.toContain("environment none|project|worktree|personal");
  });

  it("keeps the prompt short and the format in the reference; says the same about a model nobody offers", () => {
    // Audit round 2, item 17: the prompt only summarizes the format, the reference carries it.
    expect(WORKFLOW_ARCHITECT_SESSION.length).toBeLessThan(12_000);
    // A known preset is used as it is (resolveAgentModel): the note must not promise a fall-through for `offered: false`.
    const source = readFileSync(new URL("../../packages/workflow-engine/src/capabilities.ts", import.meta.url), "utf8");
    expect(source).not.toContain("offered: false falls through to Settings");
    expect(WORKFLOW_ARCHITECT_SESSION).toContain("name no pair: use a preset");
    expect(WORKFLOW_ARCHITECT_SESSION).not.toContain("say the pair is unchecked");
  });
});
