import { describe, expect, it } from "vitest";
import { accepted, goals, out, pathOf, task, taskResults } from "./chain-helpers";
import { runSim } from "./chain-harness";
import type { SimResult } from "./chain-harness";

/**
 * Test cases of the built-in chains (workflow-chains-spec.md section 3): the chain's own graph runs on the real engine; the
 * fragments it calls (lp.analyze, lp.plan, lp.build, lp.review, lp.close) either run too on stubs of their agents or are stubbed
 * by their workflow id. `path` is the nodes that ran or were skipped, in order, the way the spec's `expect_path` lists them.
 */
describe("analyze-plan-execute", () => {
  const small = { "lp.analyze": { scope_verdict: "small", recommendation: "go", confidence: 80 }, "lp.plan": { status: "ok", task_count: 1, has_ui: false, tasks: [task("t1")], waves: [["t1"]] } };
  const input = { goal: "Add a --json flag to the report command with a test", scope: "src/cli/report.ts", quality_mode: "standard" };

  it("the spec's case: analyze, plan, build, qa skipped, close, done", async () => {
    const r = await runSim("analyze-plan-execute", { input, stubs: { ...small, run_tasks: accepted("abc1234") } });
    expect(r.summary.status).toBe("succeeded");
    expect(pathOf(r)).toBe("contract analyze plan build qa close done");
    expect(out(r)).toMatchObject({ status: "done", merged_commits: ["abc1234"], goals_met: true });
    // The analysis depth follows the quality mode; the plan gets the analysis and the boundary of the contract.
    expect(r.called("analyze")[0]!.input).toMatchObject({ goal: input.goal, depth: "standard" });
    expect(r.skipped).toEqual(expect.arrayContaining(["qa"]));
  });

  const two = { ...small, "lp.plan": { ...small["lp.plan"], task_count: 2, tasks: [task("t1"), task("t2")] } };
  it("a failed task is replanned from its findings once and built again", async () => {
    const r = await runSim("analyze-plan-execute", { input, stubs: { ...two, run_tasks: taskResults(accepted("c1"), { state: "failed", verdict: { status: "rework", findings: [{ file: "a.ts", severity: "high", evidence: "e" }] } }, accepted("c2")), replan_failed: { status: "ok", tasks: [task("t2b")] } } });
    expect(pathOf(r)).toBe("contract analyze plan build replan_failed build qa close done");
    expect(r.called("replan_failed")[0]!.input).toMatchObject({ mode: "gaps", gaps: [{ file: "a.ts", severity: "high", evidence: "e" }] });
    expect(out(r)).toMatchObject({ status: "done", merged_commits: ["c1", "c2"] });
  });

  it("when the replan does not help the owner is asked; abort ends partial, accept goes on to close", async () => {
    const stubs = () => ({ ...two, run_tasks: taskResults(accepted("c1"), { state: "failed" }, accepted("c1"), { state: "failed" }), replan_failed: { status: "ok" } });
    const abort = await runSim("analyze-plan-execute", { input, stubs: stubs(), humans: { ask_partial: { answer_kind: "abort" } } });
    expect(pathOf(abort)).toBe("contract analyze plan build replan_failed build ask_partial partial");
    expect(out(abort)).toMatchObject({ status: "partial", goals_met: false });
    const accept = await runSim("analyze-plan-execute", { input, stubs: stubs(), humans: { ask_partial: { answer_kind: "accept" } } });
    expect(pathOf(accept)).toBe("contract analyze plan build replan_failed build ask_partial close done");
  });

  it("goals that are not met after the close replan once and close again; a second failure is partial", async () => {
    const r = await runSim("analyze-plan-execute", { input, stubs: { ...small, run_tasks: accepted("c1"), "lp.close": [{ status: "unmet", unmet_ids: ["g1"] }, { status: "closed" }], replan_unmet: { status: "ok" } } });
    expect(pathOf(r)).toBe("contract analyze plan build qa close replan_unmet build qa close done");
    const again = await runSim("analyze-plan-execute", { input, stubs: { ...small, run_tasks: accepted("c1"), "lp.close": { status: "unmet", unmet_ids: ["g1"] }, replan_unmet: { status: "ok" } } });
    expect(pathOf(again)).toBe("contract analyze plan build qa close replan_unmet build qa close partial");
    expect(out(again)).toMatchObject({ status: "partial", unmet_ids: ["g1"] });
  });

  it("a large scope with wants_roadmap proposes roadmap-driven instead of planning", async () => {
    const r = await runSim("analyze-plan-execute", { input: { ...input, wants_roadmap: true }, stubs: { "lp.analyze": { scope_verdict: "large", recommendation: "go", confidence: 70 } } });
    expect(pathOf(r)).toBe("contract analyze propose_roadmap proposed");
    expect(out(r)).toMatchObject({ status: "proposed", proposed_workflow: "roadmap-driven" });
    const step = r.db.prepare("SELECT receipt_json FROM lane_pilot_wf_step WHERE run_id=? AND node_id='propose_roadmap'").get(r.summary.runId) as { receipt_json: string };
    expect(JSON.parse(step.receipt_json).detail).toMatchObject({ proposed: "roadmap-driven", inputs: { goal: input.goal } });
  });

  it("an unclear scope, a no-go or a low confidence asks the owner: clarify analyzes again, abort blocks", async () => {
    const stubs = { ...small, "lp.analyze": [{ scope_verdict: "unknown", recommendation: "go", confidence: 80 }, { scope_verdict: "small", recommendation: "go", confidence: 80 }], run_tasks: accepted("c1") };
    const clarify = await runSim("analyze-plan-execute", { input, stubs, humans: { ask_scope: { answer_kind: "clarify" } } });
    expect(pathOf(clarify)).toBe("contract analyze ask_scope analyze plan build qa close done");
    const abort = await runSim("analyze-plan-execute", { input, stubs: { ...stubs, "lp.analyze": { scope_verdict: "small", recommendation: "no_go", confidence: 80 } }, humans: { ask_scope: { answer_kind: "abort" } } });
    expect(pathOf(abort)).toBe("contract analyze ask_scope blocked");
    expect(out(abort)).toMatchObject({ status: "blocked", merged_commits: [] });
    const proceed = await runSim("analyze-plan-execute", { input, stubs: { ...stubs, "lp.analyze": { scope_verdict: "small", recommendation: "go", confidence: 30 } }, humans: { ask_scope: { answer_kind: "proceed" } } });
    expect(pathOf(proceed)).toBe("contract analyze ask_scope plan build qa close done");
  });

  it("a failed plan blocks without building", async () => {
    const r = await runSim("analyze-plan-execute", { input, stubs: { ...small, "lp.plan": { status: "failed" } } });
    expect(pathOf(r)).toBe("contract analyze plan blocked");
  });

  it("full mode with a UI task runs the browser check; a failed check asks the owner", async () => {
    const stubs = { ...small, "lp.plan": { status: "ok", has_ui: true, tasks: [task("t1")] }, run_tasks: accepted("c1") };
    const pass = await runSim("analyze-plan-execute", { input: { ...input, quality_mode: "full" }, stubs: { ...stubs, qa: { status: "pass" } } });
    expect(pathOf(pass)).toBe("contract analyze plan build qa close done");
    expect(pass.skipped).not.toContain("qa");
    expect(r1(pass).depth).toBe("deep");
    const fail = await runSim("analyze-plan-execute", { input: { ...input, quality_mode: "full" }, stubs: { ...stubs, qa: { status: "rework" } }, humans: { ask_partial: { answer_kind: "abort" } } });
    expect(pathOf(fail)).toBe("contract analyze plan build qa ask_partial partial");
  });

  it("a saved plan skips the analysis and the planning; given goals skip the contract", async () => {
    const r = await runSim("analyze-plan-execute", { input: { goal: "g", tasks: [task("t1")], goals }, stubs: { run_tasks: accepted("c1") } });
    expect(pathOf(r)).toBe("contract analyze plan build qa close done");
    expect(r.skipped).toEqual(expect.arrayContaining(["contract", "analyze", "plan"]));
    expect(r.called("run_tasks:child")[0]!.input).toBeDefined();
    expect(out(r)).toMatchObject({ status: "done" });
  });
});
const r1 = (result: SimResult) => result.called("analyze")[0]!.input;
