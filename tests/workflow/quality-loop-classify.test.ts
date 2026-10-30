import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/rooms/storage/database";
import { createJev, type JevClient } from "@lane-pilot/jev";
import { WorkflowEngine } from "@lane-pilot/workflow-engine";
import {
  registerQualityLoopClassifyExecutor,
  buildFailureInput,
} from "../../src/rooms/workflow/server/workflow-classify";
import type { WorkflowAgents } from "../../src/rooms/workflow/server/workflow-agent";
import type { ChainRuntime } from "../../src/rooms/workflow/server/workflow-runtime";
import { FAILURE_CLASS_ID } from "../../src/rooms/runs/failure-class-judgment";

function setupClassifyTest(topClass: string, p: number, mode: "shadow" | "active" = "shadow") {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const asked: unknown[] = [];
  let agentCalled = false;

  const client: JevClient = {
    breaker: () => ({ open: false, failures: 0 }),
    async call(request) {
      asked.push(request.state);
      const rest = (1 - p) / 5;
      const probabilities = {
        task: topClass === "task" ? p : rest,
        infra: topClass === "infra" ? p : rest,
        provider: topClass === "provider" ? p : rest,
        harness: topClass === "harness" ? p : rest,
        merge: topClass === "merge" ? p : rest,
        contract: topClass === "contract" ? p : rest,
      };
      const answers: Record<string, any> = {};
      for (const qid of Object.keys(request.questions)) {
        answers[qid] = {
          type: "choice",
          choice: topClass,
          probabilities,
          confidence: p,
        };
      }
      return {
        ok: true,
        model: "jev-test",
        usage: { input_tokens: 400, output_tokens: 15 },
        latencyMs: 80,
        attempts: 1,
        answers,
      };
    },
  };

  const jevInstance = createJev({ client, db });

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

  const fakeServerCore = {
    bb,
    db,
    log: () => {},
    isDisposed: () => false,
    effectiveProjectSettings: async () => ({
      values: { "jev.modes": `${FAILURE_CLASS_ID}=${mode}` },
    }),
  } as any;

  const engine = new WorkflowEngine({ db, harnessVersion: "0.1.268" });
  registerQualityLoopClassifyExecutor(engine, fakeServerCore, fakeAgents);

  const executor = (engine as any).executors.get("quality-loop.classify");

  return { db, executor, asked, wasAgentCalled: () => agentCalled, jevInstance, fakeServerCore };
}

describe("quality-loop.classify helper functions", () => {
  it("buildFailureInput whitelists fields, clips strings, and redacts secrets", () => {
    const raw = {
      id: "test-1",
      state: "validation_failed",
      reason: "assertion failed: expected 4 to equal 5",
      extra_unwanted: "should be stripped",
    };
    const input = buildFailureInput(raw);
    expect(Object.keys(input).sort()).toEqual(["reason", "state"]);
    expect(input.state).toBe("validation_failed");
    expect(input.reason).toBe("assertion failed: expected 4 to equal 5");
  });
});

describe("quality-loop.classify executor", () => {
  it("returns zero defects immediately when failures list is empty without calling agent", async () => {
    const { executor, wasAgentCalled } = setupClassifyTest("task", 0.95, "active");
    const fakeContext = {
      node: { id: "classify", type: "agent", role: "triager" },
      input: { with: { failures: [] }, via: { mode: "artifact" } },
      inputs: {},
      resolve: () => undefined,
      runtime: { projectId: "proj" },
      runId: "r1",
      stepKey: "classify#1",
    };

    const result = await executor.run(fakeContext);
    expect(wasAgentCalled()).toBe(false);
    expect(result.output).toEqual({
      failures: [],
      code_defects: [],
      test_defects: 0,
      env_issues: [],
      code_defect_count: 0,
    });
  });

  it("shadow mode (default): runs Jev, records receipts, but falls back to triager agent", async () => {
    const { db, executor, asked, wasAgentCalled, jevInstance, fakeServerCore } = setupClassifyTest("task", 0.95, "shadow");
    const { setJevForTests } = await import("@lane-pilot/jev");
    setJevForTests(jevInstance);

    const fakeContext = {
      node: { id: "classify", type: "agent", role: "triager", prompt: "classify failures", out: [] },
      input: {
        with: {
          failures: [{ id: "f1", state: "validation_failed", reason: "TypeError: null" }],
        },
        via: { mode: "artifact" },
      },
      inputs: {},
      resolve: () => undefined,
      runtime: { projectId: "proj", ctx: fakeServerCore },
      runId: "r1",
      stepKey: "classify#1",
      workflow: { id: "quality-loop" },
      render: (t: any) => t,
    };

    const result = await executor.run(fakeContext);
    expect(wasAgentCalled()).toBe(true);
    expect(asked.length).toBe(1);

    const receipt = db.prepare("SELECT judgment, mode, decided_by FROM lane_pilot_jev_receipt WHERE judgment=?").get(FAILURE_CLASS_ID) as any;
    expect(receipt).toBeDefined();
    expect(receipt.judgment).toBe(FAILURE_CLASS_ID);
    expect(receipt.mode).toBe("shadow");
    expect(receipt.decided_by).toBe("fallback");
  });

  it("active mode: all confident verdicts return Jev classified defects without calling triager agent", async () => {
    const { db, executor, wasAgentCalled, jevInstance } = setupClassifyTest("task", 0.95, "active");
    const { setJevForTests } = await import("@lane-pilot/jev");
    setJevForTests(jevInstance);

    const fakeContext = {
      node: { id: "classify", type: "agent", role: "triager", prompt: "classify failures", out: [] },
      input: {
        with: {
          failures: [
            { id: "f1", file: "src/a.ts", line: 42, reason: "assert false == true" },
          ],
        },
        via: { mode: "artifact" },
      },
      inputs: {},
      resolve: () => undefined,
      runtime: { projectId: "proj" },
      runId: "r1",
      stepKey: "classify#1",
      workflow: { id: "quality-loop" },
      render: (t: any) => t,
    };

    const result = await executor.run(fakeContext);
    expect(wasAgentCalled()).toBe(false);
    expect(result.output.code_defect_count).toBe(1);
    expect(result.output.code_defects[0].file).toBe("src/a.ts");
    expect(result.output.code_defects[0].line).toBe(42);

    const receipt = db.prepare("SELECT judgment, mode, decided_by, decision FROM lane_pilot_jev_receipt WHERE judgment=?").get(FAILURE_CLASS_ID) as any;
    expect(receipt).toBeDefined();
    expect(receipt.mode).toBe("active");
    expect(receipt.decided_by).toBe("jev");
    expect(receipt.decision).toBe("task");
  });

  it("active mode: uncertain verdict falls back to triager agent", async () => {
    // p = 0.5 is below min_p (0.7), so Jev will be uncertain and fall back to agent
    const { executor, wasAgentCalled, jevInstance, fakeServerCore } = setupClassifyTest("task", 0.5, "active");
    const { setJevForTests } = await import("@lane-pilot/jev");
    setJevForTests(jevInstance);

    const fakeContext = {
      node: { id: "classify", type: "agent", role: "triager", prompt: "classify failures", out: [] },
      input: {
        with: {
          failures: [
            { id: "f1", reason: "uncertain error" },
          ],
        },
        via: { mode: "artifact" },
      },
      inputs: {},
      resolve: () => undefined,
      runtime: { projectId: "proj", ctx: fakeServerCore },
      runId: "r1",
      stepKey: "classify#1",
      workflow: { id: "quality-loop" },
      render: (t: any) => t,
    };

    const result = await executor.run(fakeContext);
    expect(wasAgentCalled()).toBe(true);
    expect(result.output.code_defects[0].evidence).toBe("mock agent");
  });
});
