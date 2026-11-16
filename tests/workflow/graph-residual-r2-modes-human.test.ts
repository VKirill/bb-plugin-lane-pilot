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
    const context = (node: Extract<GraphNode, { type: "agent" }>): StepContext<ChainRuntime> => ({
      runtime: { ctx: {}, projectId: "project", runId: null, pmThreadId: null, services: {} },
      workflow,
      node,
      nodeId: node.id,
      runId: "run",
      stepKey: `${node.id}#1`,
      spawnKey: `${node.id}:spawn`,
      mode: "standard",
      signal: new AbortController().signal,
      input: { with: {}, via: { mode: "artifact", fromStep: null } },
      inputs: { phase_id: "ph_sample01", machine: false },
      goals: [],
      reground: false,
      resolve: () => undefined,
      render: (text: string) => text,
    } as unknown as StepContext<ChainRuntime>);

    for (const id of ["critic_a", "converge"]) {
      const node = workflow.nodes.find((candidate) => candidate.id === id) as Extract<GraphNode, { type: "agent" }>;
      const request = agentRequest(context(node), node);
      expect(request.plugins).toEqual([]);
      const policy = roleProfilePolicy(request.role as never, {}, extraAccessOf(request));
      expect(policy.bbPlugins?.names ?? []).not.toContain("lane-pilot");
    }
    expect(workflow.entry).toBe("phase_status");
    const phaseStatus = workflow.nodes.find((node) => node.id === "phase_status") as Extract<GraphNode, { type: "action" }>;
    const phaseCheck = workflow.nodes.find((node) => node.id === "phase_check") as Extract<GraphNode, { type: "action" }>;
    expect(phaseStatus.action).toBe("lp.phase_status");
    expect(phaseCheck.action).toBe("lp.phase_plan_check");
    const criticB = workflow.nodes.find((node) => node.id === "critic_b") as Extract<GraphNode, { type: "agent" }>;
    expect(agentRequest(context(criticB), criticB).plugins).toEqual([]);
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
