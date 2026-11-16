import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphNode, StepContext } from "@lane-pilot/workflow-engine";
import { loadWorkflowStore, parseWorkflow } from "@lane-pilot/workflow-engine";
import { BUILTIN_SOURCES } from "../../src/rooms/workflow/builtin";
import { roleProfilePolicy } from "../../src/rooms/contracts/helper-context";
import { agentRequest, extraAccessOf } from "../../src/rooms/workflow/server/workflow-agent";
import { humanOptions, humanOutput } from "../../src/rooms/workflow/server/workflow-human-form";
import type { ChainRuntime } from "../../src/rooms/contracts/server";
import { runSim } from "./chain-harness";
import { chain, runHomeWorld } from "./run-home-world";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createCore } from "../../src/rooms/core/server/core";
import { createRun, openDatabase } from "../../src/rooms/plugin-db";
import { createPhaseDriver } from "../phase-driver";
import { registerPhaseActions } from "../../src/rooms/workflow/server/workflow-phase-actions";
import { sha256Hex } from "@lane-pilot/kit";

const store = () => loadWorkflowStore({ builtin: BUILTIN_SOURCES });
const reportGraph = (path: string) => chain({
  inputs: [{ name: "metrics", type: "any" }, { name: "insights", type: "array" }],
  outputs: [{ name: "report_path", type: "string", required: false }],
  nodes: [
    { id: "report", type: "action", action: "fs.write", params: { path }, reads: ["$inputs.metrics", "$inputs.insights"], out: { report_path: "string" } },
    { id: "living", type: "action", action: "lp.retro_living", out: { updated: "int", total: "int", path: "string" } },
    { id: "done", type: "action", action: "emit", map: { report_path: "report.report_path" } },
  ],
  edges: [{ from: "start", to: "report" }, { from: "report", to: "living" }, { from: "living", to: "done" }],
});

const phaseRisks = { value: "none", usability: "none", feasibility: "none", viability: "none" };

async function realPhaseAction(decision: "approve" | "changes_requested") {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.send", async () => ({}));
  harness.sdk.stub("threads.get", async () => ({ status: "idle" }));
  harness.sdk.stub("threads.list", async () => []);
  const db = openDatabase(bb);
  createRun(db, "run-phase", "projA");
  db.prepare("UPDATE lane_pilot_run SET pm_thread_id=? WHERE id=?").run("thr_pm", "run-phase");
  const ctx = createCore(bb, db);
  const phases = createPhaseDriver(ctx, {
    runBudgets: { get: () => undefined },
    readWriterWorkspaceFile: async ({ path }: { path: string }) => ({ sha256: sha256Hex(path), sizeBytes: 40, content: `# ${path}` }),
  } as never).phases;
  let phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Plan", goal: "prove plan" });
  phase = await phases.context({ phaseId: phase.id, docs: ["docs/CONTEXT.md"], risks: phaseRisks, requirements: ["R1"], appetite: "one day", noGos: ["none"] });
  phases.plan({ phaseId: phase.id, items: [], alreadyMet: "the goal is already met", by: "lp.plan" });
  phase = phases.resolve("projA", phase.id)!;
  const planSha = phase.record.plan!.sha;
  const parentRunId = `wfrun_parent_${decision}`;
  const childRunId = `wfrun_proof_${decision}`;
  const now = Date.now() + 10_000;
  const definition = JSON.stringify({ id: "plan-review-convergence-proof", nodes: [
    { id: "critic_a", type: "agent", role: "plan-critic" },
    { id: "critic_b", type: "agent", role: "specialist-reviewer" },
    { id: "converge", type: "agent", role: "plan-critic" },
  ] });
  db.prepare("INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,link_run_id,parent_run_id,parent_step_key,status,inputs_json,output_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(parentRunId, "plan-review-convergence", 1, "parent-sha", JSON.stringify({ id: "plan-review-convergence" }), "projA", "run-phase", null, null, "running", JSON.stringify({ phase_id: phase.id }), null, now, now);
  db.prepare("INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,link_run_id,parent_run_id,parent_step_key,status,inputs_json,output_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(childRunId, "plan-review-convergence-proof", 1, "proof-sha", definition, "projA", "run-phase", parentRunId, "proof#1", "succeeded",
      JSON.stringify({ phase_id: phase.id, plan_sha: planSha, phase_status: {} }), JSON.stringify({ decision, findings: [], rounds: 1, plan_sha: planSha, plan_verdict: decision === "approve" ? "pass" : "changes_requested", status: decision === "approve" ? "ok" : "changes_requested" }), now, now);
  for (const [index, [node, role, thread]] of [["critic_a", "plan-critic", "thr_a"], ["critic_b", "specialist-reviewer", "thr_b"], ["converge", "plan-critic", "thr_converge"]].entries()) {
    db.prepare("INSERT INTO lane_pilot_wf_step(run_id,step_key,origin,node_id,visit,state,receipt_json,started_at,ended_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(childRunId, `${node}#1`, `${node}#1`, node, 1, "succeeded", JSON.stringify({ threadId: thread }), now + index + 1, now + index + 2, now + index + 2);
    void role;
  }
  const actions = new Map<string, (c: StepContext<ChainRuntime>, rt: ChainRuntime) => Promise<Record<string, unknown>>>();
  registerPhaseActions({} as never, ctx, { phases } as never, { action: (key, run) => actions.set(key, run as never) });
  const runtime = { ctx, projectId: "projA", runId: "run-phase", pmThreadId: "thr_pm", services: { phases } } as unknown as ChainRuntime;
  const input = { with: {}, via: { mode: "artifact" as const, fromStep: "proof#1" } };
  const actionContext = {
    runId: parentRunId,
    stepKey: "phase_check#1",
    nodeId: "phase_check",
    input,
    inputs: { phase_id: phase.id },
    resolve: (ref: string) => ref === "$inputs.phase_id" ? phase.id : ref === "proof.decision" ? decision : ref === "proof.findings" ? [] : ref === "proof.rounds" ? 1 : undefined,
  } as unknown as StepContext<ChainRuntime>;
  const output = await actions.get("lp.phase_plan_check")!(actionContext, runtime);
  return { output, phases, phaseId: phase.id, childRunId, db };
}

describe("P04-R2 optional modes and human remarks", () => {
  it("turns a free-text full-lifecycle UAT remark into issues and routes it through replan", async () => {
    const workflows = await store();
    const lifecycle = workflows.get("full-lifecycle")!.workflow;
    const uat = lifecycle.nodes.find((node) => node.id === "uat") as Extract<GraphNode, { type: "human" }>;
    expect(uat.skip_out).toMatchObject({ answer_kind: "skipped" });
    expect(humanOptions(uat)).not.toContain("skipped");
    const remark = humanOutput(uat, { choiceIndex: null, text: "The export button opens nothing." });
    expect(remark).toMatchObject({ answer_kind: "issues", issues: [{ answer: "The export button opens nothing." }] });

    const result = await runSim("full-lifecycle", {
      mode: "full",
      input: { goal: "Add an export button" },
      stubs: {
        contract: { goals: [], boundary: {} },
        "lp.analyze": { decisions: [], risks: [], scope_verdict: "small", recommendation: "go", confidence: 90, open_questions: [], residual_risks: [], anchors: [] },
        plan: { status: "ok", tasks: ["initial"], waves: [], has_ui: true },
        build: { status: "done", merged_commits: ["c1"] },
        review: { status: "pass", findings: [] },
        qa: { status: "pass", findings: [] },
        replan: { status: "ok", tasks: ["fix-export"], waves: [], has_ui: true },
        rebuild: { status: "done", merged_commits: ["c2"] },
        "lp.close": { status: "closed" },
      },
      humans: { uat: [remark!, { answer_kind: "ok", issues: [] }] },
    });

    expect(result.summary.status).toBe("succeeded");
    expect(result.path).toEqual(["contract", "analyze", "plan", "build", "review", "qa", "uat", "replan", "rebuild", "review", "qa", "uat", "close", "done"]);
  });

  it("keeps phase controls code-owned and leaves both critics without a plugin grant", async () => {
    const workflows = await store();
    const workflow = workflows.get("plan-review-convergence")!.workflow;
    const proof = workflows.get("plan-review-convergence-proof")!.workflow;
    const context = (wf: typeof workflow, node: Extract<GraphNode, { type: "agent" }>): StepContext<ChainRuntime> => ({
      runtime: { ctx: {}, projectId: "project", runId: null, pmThreadId: null, services: {} },
      workflow: wf,
      node,
      nodeId: node.id,
      runId: "run",
      stepKey: `${node.id}#1`,
      spawnKey: `${node.id}:spawn`,
      mode: "standard",
      signal: new AbortController().signal,
      input: { with: {}, via: { mode: "artifact", fromStep: null } },
      inputs: { phase_id: "ph_sample01", machine: false, plan_sha: "plan_sample01", phase_status: {} },
      goals: [],
      reground: false,
      resolve: () => undefined,
      render: (text: string) => text,
    } as unknown as StepContext<ChainRuntime>);

    for (const id of ["critic_a", "converge"]) {
      const node = proof.nodes.find((candidate) => candidate.id === id) as Extract<GraphNode, { type: "agent" }>;
      const request = agentRequest(context(proof, node), node);
      expect(request.plugins).toEqual([]);
      const policy = roleProfilePolicy(request.role as never, {}, extraAccessOf(request));
      expect(policy.bbPlugins?.names ?? []).not.toContain("lane-pilot");
    }
    expect(workflow.entry).toBe("phase_status");
    const phaseStatus = workflow.nodes.find((node) => node.id === "phase_status") as Extract<GraphNode, { type: "action" }>;
    const phaseCheck = workflow.nodes.find((node) => node.id === "phase_check") as Extract<GraphNode, { type: "action" }>;
    expect(phaseStatus.action).toBe("lp.phase_status");
    expect(phaseCheck.action).toBe("lp.phase_plan_check");
    const criticB = proof.nodes.find((node) => node.id === "critic_b") as Extract<GraphNode, { type: "agent" }>;
    expect(agentRequest(context(proof, criticB), criticB).plugins).toEqual([]);
    expect(workflow.nodes.find((node) => node.id === "proof")).toMatchObject({ type: "subworkflow", workflow: "plan-review-convergence-proof" });
  });

  it("uses two quick retrospective lenses, preserves supplied standard lenses, and returns the persisted report path", async () => {
    const common = {
      input: { run_id: "run-retro", lenses: ["technical", "process", "quality", "decision"] },
      stubs: {
        retro: { insights: [{ id: "INS-1a2b3c4d" }], metrics: {}, retro_path: "invented.md" },
        report: { report_path: ".agents/retro/reports/real.md" },
        living: { updated: 1, total: 1, path: ".agents/retro/LIVING.md" },
        stage: { staged: 1 },
      },
    } as const;
    const quick = await runSim("retrospective", { ...common, mode: "quick" });
    const standard = await runSim("retrospective", { ...common, mode: "standard" });

    expect(quick.called("retro")[0]!.input.lenses).toEqual(["technical", "process"]);
    expect(standard.called("retro")[0]!.input.lenses).toEqual(["technical", "process", "quality", "decision"]);
    expect(quick.summary.output).toMatchObject({ retro_path: ".agents/retro/reports/real.md" });
    expect(standard.summary.output).toMatchObject({ retro_path: ".agents/retro/reports/real.md" });
  });

  it("uses the completed proof child for a real PhaseApi approval", async () => {
    const result = await realPhaseAction("approve");
    expect(result.output).toMatchObject({ status: "recorded", decision: "approve", checker_run_id: result.childRunId });
    const status = result.phases.status(result.phaseId);
    expect(status.gates.plan).toMatchObject({ ok: true });
    expect(status.phase.record.plan?.critique).toMatchObject({ decision: "approve", independence: { ok: true, wfRunId: result.childRunId } });
  });

  it("records real changes_requested rework without hiding an unrelated PhaseApi refusal", async () => {
    const result = await realPhaseAction("changes_requested");
    expect(result.output).toMatchObject({ status: "recorded", decision: "changes_requested", checker_run_id: result.childRunId });
    const phase = result.phases.status(result.phaseId).phase;
    expect(phase.stage).toBe("planning");
    expect(phase.record.plan?.critique).toMatchObject({ decision: "changes_requested", independence: { ok: true, wfRunId: result.childRunId } });
  });

  it("persists a report when living is off and when there are no insights", async () => {
    const graph = reportGraph(".agents/retro/reports/{{run_id}}.md");
    const world = await runHomeWorld();
    const done = await world.start(graph, { metrics: { tasks: 0 }, insights: [] }).done;
    expect(done.status).toBe("succeeded");
    const path = `.agents/retro/reports/${done.runId}.md`;
    expect(existsSync(join(world.checkout, path))).toBe(true);
    expect(readFileSync(join(world.checkout, path), "utf8")).toContain("insights");
    expect(done.output).toMatchObject({ report_path: path });
    await world.dispose();
  });

  it("fails the workflow instead of returning a report path when the real fs.write cannot create it", async () => {
    const graph = reportGraph("../retro-report.md");
    const world = await runHomeWorld();
    const done = await world.start(graph, { metrics: {}, insights: [] }).done;
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/fs\.write: the path .* is not inside the checkout/);
    await world.dispose();
  });
});
