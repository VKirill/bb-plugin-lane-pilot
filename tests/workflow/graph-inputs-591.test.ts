import { describe, expect, it } from "vitest";
import type { NodeExecutor, StepContext, Workflow } from "@lane-pilot/workflow-engine";
import { loadWorkflowStore, validateWorkflow } from "@lane-pilot/workflow-engine";
import type { WorkflowStore } from "@lane-pilot/workflow-engine";
import {BUILTIN_SOURCES} from "../../src/rooms/workflow/builtin";
import { stepPacket } from "../../src/rooms/workflow/server/workflow-agent-packet";
import { engineOn, journalDb, ok, wf } from "./engine-helpers";

/**
 * Packet P04.04/06 regressions for confirmed graph data-flow defects:
 *  - issue-full / grill-driven: the second `build` visit must receive `replan` tasks/waves, not the stale `plan` output.
 *    The two-visit sim makes visit 1 and visit 2 inputs observably different, so the old static `plan.*` mapping fails.
 *  - impeccable-build: `fix_plan` gets `qa.findings` on the QA rework path (finish_review has not run yet), and the
 *    `ask_direction` answer reaches `pack` via ctx.answers.
 *  - project-start: the `ask` answer reaches research/requirements/recap via ctx.answers.
 *  - milestone-close: the record path uses the runtime `{{run_id}}`, never an absent `$inputs.run_id`.
 * Subworkflow children are stubbed with minimal echo workflows so each call's inputs can be asserted.
 */

const load = (): Promise<WorkflowStore> => loadWorkflowStore({ builtin: BUILTIN_SOURCES });

/** A one-node stub child workflow: an agent `do` fed the run inputs, whose declared outputs are emitted verbatim.
 *  The registered `agent` executor supplies the values; per-call inputs land in `calls[workflowId]`. */
const child = (id: string, inputNames: string[], outputs: Array<{ name: string; type: string; values?: string[] }>): Workflow => wf({
  id,
  inputs: inputNames.map((name) => ({ name, type: "any" })),
  outputs: outputs.map((output) => ({ name: output.name, type: output.type, ...(output.values ? { values: output.values } : {}) })),
  nodes: [{
    id: "do", type: "agent", prompt: "stub",
    with: Object.fromEntries(inputNames.map((name) => [name, `{{$inputs.${name}}}`])),
    output: outputs.map((output) => ({ name: output.name, type: output.type, ...(output.values ? { values: output.values } : {}) })),
  }],
  edges: [
    { from: "start", to: "do" },
    { from: "do", to: "end", with: Object.fromEntries(outputs.map((output) => [output.name, `do.${output.name}`])) },
  ],
});

const STATUSES = ["ok", "low_confidence", "done", "partial", "rework", "pass", "closed", "failed", "inconclusive"];
const statusOut = { name: "status", type: "enum", values: STATUSES };

const FAKES: Record<string, Workflow> = {
  "lp.plan": child("lp.plan", ["goal", "findings", "mode", "gaps", "boundary", "plan_sha", "extra_rules", "owner_answers"], [
    statusOut, { name: "tasks", type: "json" }, { name: "waves", type: "json" }]),
  "lp.build": child("lp.build", ["tasks", "waves"], [
    statusOut, { name: "merged_commits", type: "json" }, { name: "failed_findings", type: "json" }]),
  "lp.review": child("lp.review", ["range", "pr", "files", "dimensions", "criteria"], [
    statusOut, { name: "findings", type: "json" }]),
  "lp.close": child("lp.close", ["goals", "boundary", "goal", "merged_commits", "summary", "insights", "proof_currency", "mode", "scope"], [
    statusOut, { name: "report_path", type: "string" }, { name: "staged", type: "number" }]),
  "lp.brainstorm": child("lp.brainstorm", ["topic", "hypothesis", "upstream", "roles", "research", "owner_answers"], [statusOut]),
  "grill-plan": child("grill-plan", ["plan", "goal", "depth"], [
    { name: "open", type: "json" }, { name: "locked", type: "json" }, { name: "deferred", type: "json" }, { name: "risk_register", type: "json" }]),
  "milestone-summary": child("milestone-summary", ["milestone"], [{ name: "summary_path", type: "string" }]),
};

const resolveFake = (store: WorkflowStore) => (id: string) => FAKES[id] ?? store.resolve(id);

/** The lp.run_status seam: an explicit safe run id wins; otherwise the run being closed (the PM runtime id — in this
 *  stub the engine run id stands in for it, as no PM runtime exists under test). */
const effectiveRunId = (ctx: StepContext) => {
  const requested = String(ctx.resolve("$inputs.run_id") ?? "");
  return requested && !/[/\\]/.test(requested) && requested !== "." && requested !== ".." ? requested : ctx.runId;
};

type Calls = Record<string, Array<Record<string, unknown>>>;

/** `agent` executor: logs each step's `with` keyed by node id — for fake children (single `do` node) keyed by the
 *  child workflow id, so `calls["lp.build"]` lists what each parent's subworkflow node actually delivered. */
const agents = (handlers: Record<string, (ctx: StepContext, callIndex: number) => Record<string, unknown>>, calls: Calls = {}) => {
  const agent: NodeExecutor = { reentrant: true, run: async (ctx: StepContext) => {
    const label = ctx.nodeId === "do" ? ctx.workflow.id : ctx.nodeId;
    // `packet` is what agentRequest actually renders for this step — input.with plus the consumes envelopes.
    const packet = stepPacket(ctx as never, ctx.node as never).packet;
    const index = (calls[label] ??= []).push({ ...ctx.input.with, packet }) - 1;
    const handler = handlers[`${ctx.workflow.id}:${ctx.nodeId}`] ?? handlers[ctx.nodeId] ?? handlers[ctx.workflow.id];
    return { output: { handoff: `${ctx.nodeId} done`, ...(handler ? handler(ctx, index) : {}) } };
  } };
  return { agent, calls };
};

describe("issue-full: replan output feeds the second build visit", () => {
  it("build visit 2 receives replan.tasks/waves, not the original plan's", async () => {
    const store = await load();
    const { agent, calls } = agents({
      "issue-full:triage": () => ({ severity: "high", clear: true }),
      "issue-full:root_cause": () => ({ root_cause: "the bug", affected_files: ["a.ts"], impact_scope: "s", fix_direction: "d", confidence: 80, locked: [], free: [] }),
      "issue-full:memory": () => ({ staged: 1, deferred: false }),
      "lp.plan": (_ctx, i) => ({ status: "ok", tasks: [i === 0 ? "T-PLAN" : "T-REPLAN"], waves: [[i === 0 ? "w1" : "w2"]] }),
      "lp.build": (_ctx, i) => ({ status: "done", merged_commits: i === 0 ? ["b1"] : ["b1", "b2"], failed_findings: [] }),
      "lp.review": (_ctx, i) => i === 0 ? { status: "rework", findings: [{ id: "RW" }] } : { status: "pass", findings: [] },
    });
    const engine = engineOn(journalDb(), { agent }, { resolveWorkflow: resolveFake(store) });
    const summary = await engine.start({ workflow: store.get("issue-full")!.workflow, inputs: { title: "t", text: "x" } }).done;
    expect(summary.status).toBe("succeeded");
    expect(calls["lp.build"]!.map((call) => call.tasks)).toEqual([["T-PLAN"], ["T-REPLAN"]]);
    expect(calls["lp.build"]!.map((call) => call.waves)).toEqual([[["w1"]], [["w2"]]]);
  });
});

describe("grill-driven: replan output feeds the second build visit", () => {
  it("a partial build replans once, and build visit 2 receives replan.tasks", async () => {
    const store = await load();
    const { agent, calls } = agents({
      "grill-plan": () => ({ open: [], locked: [], deferred: [], risk_register: [] }),
      "lp.brainstorm": () => ({ status: "ok" }),
      "lp.plan": (_ctx, i) => ({ status: "ok", tasks: [i === 0 ? "T-PLAN" : "T-REPLAN"], waves: [[i === 0 ? "w1" : "w2"]] }),
      "lp.build": (_ctx, i) => i === 0 ? { status: "partial", merged_commits: [], failed_findings: [{ id: "F1" }] } : { status: "done", merged_commits: ["b1"], failed_findings: [] },
      "lp.close": () => ({ status: "closed", report_path: "r.md", staged: 0 }),
    });
    const engine = engineOn(journalDb(), { agent }, { resolveWorkflow: resolveFake(store) });
    const summary = await engine.start({ workflow: store.get("grill-driven")!.workflow, inputs: { goal: "g", plan_text: "p" } }).done;
    expect(summary.status).toBe("succeeded");
    expect(calls["lp.build"]!.map((call) => call.tasks)).toEqual([["T-PLAN"], ["T-REPLAN"]]);
    // ask_open was skipped (no open items): brainstorm and plan still see an (empty) answer history — the no-answer branch.
    expect(calls["lp.brainstorm"]![0]!.owner_answers).toEqual([]);
    expect(calls["lp.plan"]![0]!.owner_answers).toEqual([]);
  });

  it("when the owner answers the open questions, brainstorm and plan receive the actual answer", async () => {
    const store = await load();
    const { agent, calls } = agents({
      "grill-plan": () => ({ open: [{ id: "Q1" }], locked: [], deferred: [], risk_register: [] }),
      "lp.brainstorm": () => ({ status: "ok" }),
      "lp.plan": () => ({ status: "ok", tasks: ["T"], waves: [["w"]] }),
      "lp.build": () => ({ status: "done", merged_commits: ["b1"], failed_findings: [] }),
      "lp.close": () => ({ status: "closed", report_path: "r.md", staged: 0 }),
    });
    const engine = engineOn(journalDb(), { agent }, { resolveWorkflow: resolveFake(store) });
    const started = engine.start({ workflow: store.get("grill-driven")!.workflow, inputs: { goal: "g", plan_text: "p" } });
    const first = await started.done;
    expect(first.status).toBe("waiting");
    expect(first.waiting[0]).toMatchObject({ nodeId: "ask_open" });
    await engine.resolve(first.runId, first.waiting[0]!.stepKey, { answer: "A-GRILL-9", answer_kind: "answered" });
    expect(engine.get(first.runId)!.status).toBe("succeeded");
    for (const id of ["lp.brainstorm", "lp.plan"]) {
      const answers = calls[id]![0]!.owner_answers as Array<{ output: { answer: string } }>;
      expect(answers[0]!.output.answer, `${id} did not see the ask_open answer`).toBe("A-GRILL-9");
    }
  });
});

describe("impeccable-build: QA findings and the ask_direction answer reach their consumers", () => {
  it("fix_plan receives qa.findings on the QA rework path, and pack receives the owner answer", async () => {
    const store = await load();
    const qaFindings = [{ file: "src/pricing.tsx", line: 55, severity: "high", evidence: "CTA unreachable", dimension: "correctness" }];
    const { agent, calls } = agents({
      "impeccable-build:brief": () => ({ surface_mode: "m", contract: "c", open_questions: ["q"], has_design_md: false, new_world: false }),
      "impeccable-build:pack": () => ({ pack_path: "p.md", token_count: 10, component_list: ["c"], prototype_path: "" }),
      "impeccable-build:qa": (_ctx, i) => i === 0 ? { status: "rework", findings: qaFindings, screenshots: [] } : { status: "pass", findings: [], screenshots: [] },
      "impeccable-build:finish_review": () => ({ disposition: "ship", score: 95, p0_count: 0, p1_count: 0, findings: [] }),
      "lp.plan": () => ({ status: "ok", tasks: ["T"], waves: [["w"]] }),
      "lp.build": () => ({ status: "done", merged_commits: ["b1"], failed_findings: [] }),
      "lp.close": () => ({ status: "closed", report_path: "r.md", staged: 0 }),
    });
    const engine = engineOn(journalDb(), {
      agent,
      "lp-task": ok(() => ({ state: "accepted", merge_commit: "m1" })),
      "deliverable.validate": ok(() => ({ ok: true, verdict: "pass", reason: "", details: {} })),
    }, { resolveWorkflow: resolveFake(store) });
    const started = engine.start({ workflow: store.get("impeccable-build")!.workflow, inputs: { goal: "g" } });
    const first = await started.done;
    expect(first.status).toBe("waiting");
    expect(first.waiting[0]).toMatchObject({ nodeId: "ask_direction" });
    await engine.resolve(first.runId, first.waiting[0]!.stepKey, { answer: "ANSWER-DIR-7", answer_kind: "answered" });
    expect(engine.get(first.runId)!.status).toBe("succeeded");
    // pack saw the human answer history with the actual answer value, both as input and in the rendered step packet.
    const answers = calls["pack"]![0]!.owner_answers as Array<{ output: { answer: string } }>;
    expect(answers[0]!.output.answer).toBe("ANSWER-DIR-7");
    expect(calls["pack"]![0]!.packet).toContain("ANSWER-DIR-7");
    // fix_plan is the second lp.plan call; gaps are the QA findings, not finish_review's (which had not run).
    expect(calls["lp.plan"]![1]!.gaps).toEqual(qaFindings);
  });

  it("the finish_review -> fix_plan edge delivers finish_review.findings with no cross-edge override", async () => {
    const store = await load();
    const reviewFindings = [{ file: "src/x.tsx", line: 9, severity: "medium", evidence: "contrast", dimension: "accessibility" }];
    const { agent, calls } = agents({
      "impeccable-build:brief": () => ({ surface_mode: "m", contract: "c", open_questions: [], has_design_md: false, new_world: false }),
      "impeccable-build:pack": () => ({ pack_path: "p.md", token_count: 10, component_list: ["c"], prototype_path: "" }),
      "impeccable-build:qa": () => ({ status: "pass", findings: [], screenshots: [] }),
      "impeccable-build:finish_review": (_ctx, i) => i === 0
        ? { disposition: "fix", score: 60, p0_count: 0, p1_count: 1, findings: reviewFindings }
        : { disposition: "ship", score: 95, p0_count: 0, p1_count: 0, findings: [] },
      "lp.plan": () => ({ status: "ok", tasks: ["T"], waves: [["w"]] }),
      "lp.build": () => ({ status: "done", merged_commits: ["b1"], failed_findings: [] }),
      "lp.close": () => ({ status: "closed", report_path: "r.md", staged: 0 }),
    });
    const engine = engineOn(journalDb(), {
      agent,
      "lp-task": ok(() => ({ state: "accepted", merge_commit: "m1" })),
      "deliverable.validate": ok(() => ({ ok: true, verdict: "pass", reason: "", details: {} })),
    }, { resolveWorkflow: resolveFake(store) });
    // open_questions is empty: ask_direction is skipped, so pack still gets a (empty) answer history — the no-answer branch.
    const summary = await engine.start({ workflow: store.get("impeccable-build")!.workflow, inputs: { goal: "g" } }).done;
    expect(summary.status).toBe("succeeded");
    expect(calls["pack"]![0]!.owner_answers).toEqual([]);
    expect(calls["lp.plan"]).toHaveLength(2);
    expect(calls["lp.plan"]![1]!.gaps).toEqual(reviewFindings);
  });
});

describe("project-start: the ask answer reaches downstream consumers", () => {
  it("research, requirements and recap each receive ctx.answers.ask with the actual answer", async () => {
    const store = await load();
    const { agent, calls } = agents({
      "project-start:value_map": () => ({ document: "v" }),
      "project-start:preview": () => ({ stack: {}, memory: {}, profile: {} }),
      "project-start:research": () => ({ research_notes: "notes", stack: "", features: "", architecture: "", pitfalls: "" }),
      "project-start:requirements": () => ({ requirements: ["r1"], document: "# req\n" }),
      "project-start:recap": () => ({ next_steps: ["n1"], roadmap_draft: "# road\n", project_document: "# proj\n", phases: ["1 p"] }),
    });
    const engine = engineOn(journalDb(), {
      agent,
      "lp.tree_counts": ok(() => ({ enabled: "on", sources: 1, tests: 1, docs: 1, planning: 1, commits: 1, counts_note: "", profile_note: "", recap_note: "" })),
      "lp.state_probe": ok(() => ({ has_passport: false, open_tasks: 0, plan_exists: false, has_ui: false, has_value_map: false, has_roadmap: false, has_profile: false })),
      "lp.profile_write": ok(() => ({ refused: [], set: [], reasons: [] })),
      "fs.write": ok(() => ({ value_map_path: "w.md", requirements_path: "w.md", roadmap_path: "w.md", research_path: "w.md", project_path: "w.md" })),
      "lp.phase_add": ok(() => ({ added: [], count: 0 })),
    });
    const started = engine.start({ workflow: store.get("project-start")!.workflow, inputs: { goal: "g" } });
    const first = await started.done;
    expect(first.status).toBe("waiting");
    expect(first.waiting[0]).toMatchObject({ nodeId: "ask" });
    await engine.resolve(first.runId, first.waiting[0]!.stepKey, { answer: "ANSWER-42", answer_kind: "answered" });
    expect(engine.get(first.runId)!.status).toBe("succeeded");
    for (const id of ["research", "requirements", "recap"]) {
      const answers = calls[id]![0]!.owner_answers as Array<{ output: { answer: string } }>;
      expect(answers[0]!.output.answer, `${id} did not see the ask answer`).toBe("ANSWER-42");
    }
  });
});

describe("milestone-close: record path uses the effective run id", () => {
  const run = async (inputs: Record<string, unknown>) => {
    const store = await load();
    const paths: string[] = [];
    const { agent } = agents({
      "milestone-close:retro": () => ({ insights: [], metrics: {}, project_update: "", document: "" }),
      "lp.close": () => ({ status: "closed", report_path: "r.md", staged: 0 }),
      "milestone-summary": () => ({ summary_path: "s.md" }),
    });
    const engine = engineOn(journalDb(), {
      agent,
      "lp.run_status": ok((ctx: StepContext) => ({ open_tasks: 0, failed_tasks: 0, unmerged: 0, gate_ok: true, running_attempts: 0, merged_commits: ["m1"], gate_state: "none", unmerged_seen: 0, uncovered_reqs: [], coverage_matrix: "", retro_living: "on", milestone_archive: "off", milestone_summary: "off", effective_run_id: effectiveRunId(ctx) })),
      "lp.retro_living": ok(() => ({ updated: 0, total: 0, path: "" })),
      "fs.write": ok((ctx: StepContext) => {
        if (ctx.node.type !== "action") throw new Error("fs.write requires an action node");
        const path = ctx.render(String(ctx.node.params.path));
        if (path.startsWith(".agents/milestones/")) paths.push(path);
        return { record_path: path, retro_path: path, project_path: path };
      }),
      "lp.milestone_archive": ok(() => ({ folder: "f", files: [], kept: true })),
      "lp.run_close": ok(() => ({ archived: true })),
    }, { resolveWorkflow: resolveFake(store) });
    const summary = await engine.start({ workflow: store.get("milestone-close")!.workflow, inputs, mode: "standard" }).done;
    return { summary, paths };
  };

  it("with no run_id input the record path falls back to the run being closed, never an empty name", async () => {
    const { summary, paths } = await run({});
    expect(summary.status).toBe("succeeded");
    expect(paths).toEqual([`.agents/milestones/${summary.runId}.md`]);
  });

  it("an explicit run_id input names the record after the target run", async () => {
    const { summary, paths } = await run({ run_id: "run_explicit_42" });
    expect(summary.status).toBe("succeeded");
    expect(paths).toEqual([".agents/milestones/run_explicit_42.md"]);
  });
});

describe("validate: a required subworkflow input mapped on every incoming edge", () => {
  const CHILD = wf({
    id: "req.child",
    inputs: [{ name: "tasks", type: "json", required: true }],
    outputs: [{ name: "status", type: "string" }],
    nodes: [{ id: "do", type: "agent", prompt: "x", output: [{ name: "status", type: "string" }] }],
    edges: [{ from: "start", to: "do" }, { from: "do", to: "end", with: { status: "do.status" } }],
  });
  const resolve = () => CHILD;
  const graph = (edgeWith: Array<Record<string, string> | undefined>): Workflow => wf({
    id: "req.parent",
    nodes: [
      { id: "a", type: "action", action: "a", out: [{ name: "t", type: "string" }] },
      { id: "b", type: "action", action: "b", out: [{ name: "t", type: "string" }] },
      { id: "build", type: "subworkflow", workflow: "req.child" },
      { id: "done", type: "action", action: "emit", map: { result: "build.status" } },
    ],
    edges: [
      { from: "start", to: "a" },
      { from: "a", to: "b", when: "a.t == 'x'" },
      { from: "a", to: "build", with: edgeWith[0] },
      { from: "b", to: "build", with: edgeWith[1] },
      { from: "build", to: "done" },
    ],
  });
  const inputErrors = (workflow: Workflow) => validateWorkflow(workflow, { resolve }).filter((p) => p.code === "subworkflow_input");

  it("passes when every incoming edge maps the required input", () => {
    expect(inputErrors(graph([{ tasks: "a.t" }, { tasks: "b.t" }]))).toEqual([]);
  });

  it("fails when even one incoming edge does not map it", () => {
    expect(inputErrors(graph([{ tasks: "a.t" }, undefined]))[0]?.message).toContain('input "tasks"');
  });
});
