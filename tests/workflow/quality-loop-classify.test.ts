import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/rooms/plugin-db";
import { WorkflowEngine } from "@lane-pilot/workflow-engine";
import { registerQualityLoopClassifyExecutor } from "../../src/rooms/workflow/server/workflow-classify";
import type { WorkflowAgents } from "../../src/rooms/workflow/server/workflow-agent";

function setupClassifyTest() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  let agentCalled = false;

  const fakeAgents: WorkflowAgents = {
    run: async () => {
      agentCalled = true;
      return {
        threadId: "thr_agent_mock",
        output: {
          failures: [{ id: "f1", class: "code_defect" }],
          code_defects: [{ file: "src/calc.ts", line: 10, severity: "high", evidence: "mock agent", dimension: "correctness" }],
          test_defects: 0,
          env_issues: [],
          code_defect_count: 1,
        },
        text: "agent done",
      };
    },
  };

  const fakeServerCore = { bb, db, log: () => {}, isDisposed: () => false, effectiveProjectSettings: async () => ({ values: {} }) } as any; // guardian: allow test double
  const engine = new WorkflowEngine({ db, harnessVersion: "0.1.268" });
  registerQualityLoopClassifyExecutor(engine, fakeServerCore, fakeAgents);
  const executor = (engine as any).executors.get("quality-loop.classify"); // guardian: allow test double
  return { executor, wasAgentCalled: () => agentCalled, fakeServerCore };
}

const contextOf = (failures: unknown[], fakeServerCore?: unknown) => ({
  node: { id: "classify", type: "agent", role: "triager", prompt: "classify failures", out: [] },
  input: { with: { failures }, via: { mode: "artifact" } },
  inputs: {},
  resolve: () => undefined,
  runtime: { projectId: "proj", ctx: fakeServerCore },
  runId: "r1",
  stepKey: "classify#1",
  workflow: { id: "quality-loop" },
  render: (t: any) => t, // guardian: allow test double
});

describe("quality-loop.classify executor", () => {
  it("returns zero defects immediately when failures list is empty without calling agent", async () => {
    const { executor, wasAgentCalled } = setupClassifyTest();
    const result = await executor.run(contextOf([]));
    expect(wasAgentCalled()).toBe(false);
    expect(result.output).toEqual({
      failures: [],
      code_defects: [],
      test_defects: 0,
      env_issues: [],
      code_defect_count: 0,
    });
  });

  it("gives every non-empty failure list to the triager agent; no small classifier answers first", async () => {
    const { executor, wasAgentCalled, fakeServerCore } = setupClassifyTest();
    const result = await executor.run(contextOf([{ id: "f1", state: "validation_failed", reason: "TypeError: null" }], fakeServerCore));
    expect(wasAgentCalled()).toBe(true);
    expect(result.threadId).toBe("thr_agent_mock");
    expect(result.output.code_defects[0].evidence).toBe("mock agent");
  });
});
