import { describe, expect, it } from "vitest";
import type { GraphNode, StepContext } from "@lane-pilot/workflow-engine";
import { loadWorkflowStore } from "@lane-pilot/workflow-engine";
import { BUILTIN_SOURCES } from "../../src/rooms/workflow/builtin";
import { roleProfilePolicy } from "../../src/rooms/contracts/helper-context";
import { agentRequest, extraAccessOf } from "../../src/rooms/workflow/server/workflow-agent";
import { humanOutput } from "../../src/rooms/workflow/server/workflow-human-form";
import { runSim } from "./chain-harness";

const store = () => loadWorkflowStore({ builtin: BUILTIN_SOURCES });

describe("P04-R2 optional modes and human remarks", () => {
  it("turns a free-text full-lifecycle UAT remark into issues and routes it through replan", async () => {
    const workflows = await store();
    const lifecycle = workflows.get("full-lifecycle")!.workflow;
    const uat = lifecycle.nodes.find((node) => node.id === "uat") as Extract<GraphNode, { type: "human" }>;
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

  it("keeps the sanctioned lane-pilot plugin on only the machine-capable plan critics", async () => {
    const workflows = await store();
    const workflow = workflows.get("plan-review-convergence")!.workflow;
    const context = (node: Extract<GraphNode, { type: "agent" }>): StepContext => ({
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
    } as unknown as StepContext);

    for (const id of ["critic_a", "converge"]) {
      const node = workflow.nodes.find((candidate) => candidate.id === id) as Extract<GraphNode, { type: "agent" }>;
      const request = agentRequest(context(node), node);
      expect(request.plugins).toEqual(["lane-pilot"]);
      const policy = roleProfilePolicy(request.role as never, {}, extraAccessOf(request));
      expect(policy.bbPlugins).toMatchObject({ mode: "allow", names: expect.arrayContaining(["lane-pilot"]) });
    }
    const criticB = workflow.nodes.find((node) => node.id === "critic_b") as Extract<GraphNode, { type: "agent" }>;
    expect(agentRequest(context(criticB), criticB).plugins).toEqual([]);
  });

  it("uses two quick retrospective lenses, preserves supplied standard lenses, and returns living.path", async () => {
    const common = {
      input: { run_id: "run-retro", lenses: ["technical", "process", "quality", "decision"] },
      stubs: {
        retro: { insights: [{ id: "INS-1a2b3c4d" }], retro_path: "invented.md" },
        living: { updated: 1, total: 1, path: ".agents/retro/LIVING.md" },
        stage: { staged: 1 },
      },
    } as const;
    const quick = await runSim("retrospective", { ...common, mode: "quick" });
    const standard = await runSim("retrospective", { ...common, mode: "standard" });

    expect(quick.called("retro")[0]!.input.lenses).toEqual(["technical", "process"]);
    expect(standard.called("retro")[0]!.input.lenses).toEqual(["technical", "process", "quality", "decision"]);
    expect(quick.summary.output).toMatchObject({ retro_path: ".agents/retro/LIVING.md" });
    expect(standard.summary.output).toMatchObject({ retro_path: ".agents/retro/LIVING.md" });
  });
});
