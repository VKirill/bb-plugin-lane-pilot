import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { runDraftTest, type DraftTestCase } from "@lane-pilot/workflow-engine";
import { builtinWorkflow } from "../src/rooms/workflow/builtin";
import { openDatabase } from "../src/rooms/plugin-db";

// EXT-02: lp.plan's plan_critic used to fall through to `low` on EVERY non-pass/non-rework verdict — a hard `block`
// became low_confidence and analyze-plan-execute/full-lifecycle built on it. These run the real engine on the real
// graphs through the draft simulator (every agent/action/subworkflow stubbed, routing and guards real): the child's
// verdict mapping first, then the parent's routing of the failed status.

const PLAN_STUB = { task_count: 3, tasks: [{ id: "t1" }], waves: [["t1"]], objective: "o", has_ui: false, already_met: false, premortem: [] };
const LINT_STUB = { ok: true, errors: [], waves: [["t1"]] };

async function draft(workflowId: string, testCase: DraftTestCase) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  return runDraftTest(
    { db, harnessVersion: "test", resolveWorkflow: (id: string) => builtinWorkflow(id) },
    builtinWorkflow(workflowId)!,
    testCase,
  );
}

const planCase = (critic: Record<string, unknown>): DraftTestCase => ({
  id: "critic", input: { goal: "ship it" },
  stubs: { plan: PLAN_STUB, lint: LINT_STUB, plan_critic: critic },
  humanAnswers: {}, expectStatus: "succeeded", notChecked: [],
});

it("lp.plan: a block verdict ends failed, never low_confidence", async () => {
  const result = await draft("lp.plan", { ...planCase({ status: "block", summary: "destructive ask", findings: [], evidence: "checked" }), expectOutput: { status: "failed" } });
  expect(result.failures).toEqual([]);
  expect(result.output?.status).toBe("failed");
});

it("lp.plan: pass still reaches ok, exhausted rework still reaches low", async () => {
  const pass = await draft("lp.plan", { ...planCase({ status: "pass", summary: "fine", findings: [], evidence: "checked" }), expectOutput: { status: "ok" } });
  expect(pass.failures).toEqual([]);
  expect(pass.output?.status).toBe("ok");

  // Rework past the visit budget keeps the old policy: the unconditional fallback still emits low_confidence.
  const low = await draft("lp.plan", { ...planCase({ status: "rework", summary: "fix", findings: [{ severity: "high", finding: "x" }], evidence: "checked" }), expectOutput: { status: "low_confidence" } });
  expect(low.failures).toEqual([]);
  expect(low.output?.status).toBe("low_confidence");
});

it("analyze-plan-execute: a failed lp.plan blocks the run and lp.build is never resolved", async () => {
  const result = await draft("analyze-plan-execute", {
    id: "ape-failed-plan", input: { goal: "ship it" },
    stubs: {
      // The analyze verdict routes small+go+confident straight to plan; the plan child answers failed.
      analyze: { scope_verdict: "small", recommendation: "go", confidence: 80 },
      plan: { status: "failed" },
    },
    humanAnswers: {}, expectStatus: "succeeded", expectOutput: { status: "blocked" }, notChecked: [],
  });
  expect(result.failures).toEqual([]);
  expect(result.output?.status).toBe("blocked");
  expect(result.path).toContain("blocked");
  expect(result.path).not.toContain("build");
});
