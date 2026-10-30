import { describe, expect, it } from "vitest";
import { executorKey, parseWorkflow, validateWorkflow } from "@lane-pilot/workflow-engine";
import { engineOn, journalDb, stepStates, wf } from "./engine-helpers";

const graph = (when: string) => wf({
  budget: { max_steps: 40, max_minutes: 120 },
  nodes: [
    { id: "check", type: "jev", judgment: "test.gate", state: { request: "{{input.query}}" }, output: [{ name: "decision", type: "string" }, { name: "escalated", type: "boolean" }] },
    { id: "fast", type: "action", action: "search", output: [{ name: "text", type: "string" }] },
    { id: "slow", type: "agent", role: "specialist", prompt: "decide hard", output: [{ name: "text", type: "string" }] },
  ],
  edges: [
    { from: "start", to: "check" },
    { from: "check", to: "fast", when },
    { from: "check", to: "slow" },
    { from: "fast", to: "end", with: { result: "fast.text" } },
    { from: "slow", to: "end", with: { result: "slow.text" } },
  ],
});

describe("the native jev node", () => {
  it("parses, validates and needs the builtin:jev executor", () => {
    const flow = parseWorkflow(graph("'check.decision' == 'yes'"));
    expect(validateWorkflow(flow).filter((problem) => problem.level === "error")).toEqual([]);
    const node = flow.nodes.find((item) => item.type === "jev")!;
    expect(executorKey(node)).toBe("builtin:jev");
    // The engine registers a default builtin:jev that always escalates; a runtime with real Jev replaces it.
    expect(engineOn(journalDb()).preflight(flow)).toEqual([]);
  });

  it("a sure verdict takes the cheap edge, an unsure one the model edge", async () => {
    const jevAnswer = (escalated: boolean) => ({
      reentrant: true, run: async () => ({ output: { decision: "yes", escalated } }),
    });
    for (const [escalated, fastRan, slowRan] of [[false, "succeeded", undefined], [true, undefined, "succeeded"]] as const) {
      const db = journalDb();
      const engine = engineOn(db, {
        "builtin:jev": jevAnswer(escalated),
        search: { reentrant: true, run: async () => ({ output: { text: "cheap" } }) },
        agent: { reentrant: true, run: async () => ({ output: { text: "thread", handoff: "done" } }) },
      });
      const run = await engine.start({ workflow: graph("check.escalated == false"), inputs: { query: "q" } });
      await run.done;
      const states = stepStates(db, run.runId);
      expect(states["check#1"]).toBe("succeeded");
      expect(states["fast#1"]).toBe(fastRan);
      expect(states["slow#1"]).toBe(slowRan);
    }
  });

  it("the schema refuses a bad judgment id and a missing whitelist is an empty record", () => {
    const single = (judgment: string) => wf({ budget: { max_steps: 40, max_minutes: 120 }, nodes: [{ id: "x", type: "jev", judgment, output: [{ name: "decision", type: "string" }] }], edges: [{ from: "start", to: "x" }, { from: "x", to: "end", with: { result: "x.decision" } }] });
    expect(() => parseWorkflow(single("NODOT"))).toThrow();
    const flow = parseWorkflow(single("test.gate"));
    const node = flow.nodes.find((item) => item.type === "jev")!;
    expect(node.state).toEqual({});
  });
});
