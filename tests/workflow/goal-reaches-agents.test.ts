import { describe, expect, it } from "vitest";
import { agentRequest } from "../../src/server/workflow-agent";
import type { StepContext } from "../../src/workflow/engine";
import { chainStore, runSim } from "./chain-harness";

/** The goal and the run's goals reach every agent step of the built-in fragments, also when the fragment runs as a subworkflow. */
const GOALS = [{ id: "request", done_when: "the --json flag prints valid JSON", evidence: "a test output" }];
const GOAL = "Add a --json flag to the export command";

/** The prompts the agent steps of a run are given, by node id (the engine's real context; the answer is the stub's default). */
async function promptsOf(workflowId: string, input: Record<string, unknown>, goals = GOALS) {
  const prompts = new Map<string, string>();
  const capture = (ctx: StepContext) => {
    const prompt = agentRequest(ctx as never, ctx.node as never).prompt;
    // The goals are repeated on the first step and every third; every other step must not carry them.
    expect(prompt.includes("<goals-of-this-run>"), `${workflowId}/${ctx.nodeId} goals block`).toBe(ctx.reground);
    prompts.set(ctx.nodeId, prompt);
    return {};
  };
  const result = await runSim(workflowId, { input, goals, stubs: { agent: capture } });
  return { prompts, result };
}

describe("an agent step is given the workflow's inputs and the run's goals", () => {
  it("lp.analyze: the analyst sees the goal, the scope and the goals block", async () => {
    const { prompts } = await promptsOf("lp.analyze", { goal: GOAL, scope: "src/export" });
    for (const node of ["gather", "assess"]) {
      expect(prompts.get(node), node).toContain(GOAL);
    }
    expect(prompts.get("gather")).toContain("src/export");
    expect(prompts.get("gather")).toContain("<goals-of-this-run>");
  });

  it("inside a subworkflow (analyze-code calls lp.analyze) the helper still sees the goal, the scope and the goals", async () => {
    const { prompts, result } = await promptsOf("analyze-code", { goal: GOAL, scope: "src/export" });
    expect(result.summary.status).toBe("succeeded");
    expect(prompts.get("gather")).toContain(GOAL);
    expect(prompts.get("gather")).toContain("<goals-of-this-run>");
  });

  it("every agent node of every lp.* fragment carries the fragment's required goal input in its prompt", async () => {
    const store = await chainStore();
    const inputsOf: Record<string, Record<string, unknown>> = {
      "lp.analyze": { goal: GOAL },
      "lp.plan": { goal: GOAL },
      "lp.brainstorm": { topic: GOAL },
      "lp.close": { goal: GOAL, goals: GOALS },
      "lp.review": { dimensions: ["security"], range: "HEAD~1..HEAD" },
    };
    const needle: Record<string, string> = { "lp.analyze": GOAL, "lp.plan": GOAL, "lp.brainstorm": GOAL, "lp.close": GOAL, "lp.review": "HEAD~1..HEAD" };
    expect(store.get("lp.analyze")).toBeTruthy();
    const seen: string[] = [];
    for (const [id, input] of Object.entries(inputsOf)) {
      const { prompts } = await promptsOf(id, input);
      expect(prompts.size, id).toBeGreaterThan(0);
      for (const [node, prompt] of prompts) { seen.push(`${id}/${node}`); expect(prompt, `${id}/${node}`).toContain(needle[id]!); }
    }
    expect(seen.length).toBeGreaterThan(8);
  });
});

describe("goals are carried into child runs", () => {
  it("a subworkflow's run has the parent's goals", async () => {
    const { result } = await promptsOf("analyze-code", { goal: GOAL, scope: "s" });
    const child = result.db.prepare("SELECT id, goals_json FROM lane_pilot_wf_run WHERE parent_run_id=?").get(result.summary.runId) as { id: string; goals_json: string | null };
    expect(JSON.parse(child.goals_json ?? "[]")).toEqual(GOALS);
  });
});
