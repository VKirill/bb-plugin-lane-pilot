// Region 17 · Agent roles (subagents), part 3 — auditors, researchers, mappers and planners (n1379–n1397). See four-proofs-r17-a.test.ts.
import type { GraphNode, StepContext } from "@lane-pilot/workflow-engine";
import { describe, expect, it } from "vitest";
import { fragmentJudgeVia, parseFragments } from "../../src/rooms/anamnesis/fragments";
import { compileMainAgentProfile } from "../../src/rooms/native-agent/agent-profile";
import { sessionOverrideAgentsJson } from "../../src/rooms/native-agent/native-agent-definition";
import { validationGaps } from "../../src/rooms/phase/stages";
import { agentRequest, roleSpec } from "../../src/rooms/workflow/server/workflow-agent";
import { REDUCERS } from "../../packages/workflow-engine/src/reducers";
import { chainStore, runSim } from "../workflow/chain-harness";
import { out, pathOf } from "../workflow/chain-helpers";

type AgentNode = Extract<GraphNode, { type: "agent" }>;
async function spawnOf(workflowId: string, nodeId: string) {
  const flow = (await chainStore()).get(workflowId)!.workflow;
  const node = flow.nodes.find((candidate) => candidate.id === nodeId) as AgentNode;
  const ctx = {
    runtime: { pmThreadId: "t", projectId: "", runId: "r", ctx: {}, services: {} }, workflow: flow, node, nodeId, runId: "wfrun", stepKey: `${nodeId}#1`, spawnKey: "k", mode: "standard",
    signal: new AbortController().signal, input: { with: {}, via: { mode: "artifact", fromStep: null } }, goals: [], reground: false, render: (text: string) => text, template: (value: unknown) => value,
  } as unknown as StepContext<never>;
  const request = agentRequest(ctx as never, node);
  return { node, request, spec: roleSpec(request.role), fields: Object.fromEntries(request.fields.map((field) => [field.name, field.type])) as Record<string, string> };
}
const WRITE_TOOLS = ["Write", "Edit", "NotebookEdit", "MultiEdit"];
function sessionOf(agentId: string): { tools: string[]; skills: string[] } {
  const compiled = compileMainAgentProfile(agentId);
  const json = JSON.parse(sessionOverrideAgentsJson({ agentId, edited: false, compiled })!) as Record<string, { tools?: string[]; skills?: string[] }>;
  const definition = Object.values(json)[0]!;
  return { tools: definition.tools ?? [], skills: definition.skills ?? [] };
}

describe("region 17 · specialist sessions that only read and report", () => {
  it("[sma:k_ag_nyquist] the check auditor is spawned read-only with the lane-pilot skill, and a piece whose every check only tests existence is named as a gap", () => {
    const { tools, skills } = sessionOf("nyquist-auditor");
    expect(tools).toEqual(expect.arrayContaining(["Read", "Grep", "Bash"]));
    for (const write of WRITE_TOOLS) expect(tools).not.toContain(write);
    expect(skills).toEqual(["lane-pilot"]);
    const piece = (id: string, commands: string[]) => ({ id, title: id, wave: 1, promise: { given: "g", when: "w", then: "t" }, task: { verification: commands.map((command) => ({ command })) } }) as never;
    const gaps = validationGaps([piece("p1", ["test -f out.txt", "ls dist"]), piece("p2", ["npm test", "test -f out.txt"])]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain("p1");
  });

  it("[sma:k_ag_classifier] the document classifier is spawned unable to change any file, so its answer (one kind, or a table for a folder) is all it produces", () => {
    const { tools } = sessionOf("doc-classifier");
    expect(tools).toEqual(expect.arrayContaining(["Read", "Grep", "Glob"]));
    for (const write of WRITE_TOOLS) expect(tools).not.toContain(write);
    expect(sessionOf("doc-classifier").skills).toEqual([]);
  });

  it("[sma:k_ag_advisor] the advisor is spawned read-only with the tavily search skill, so a gray area is researched and reported, not changed", () => {
    const { tools, skills } = sessionOf("advisor-researcher");
    expect(tools).toEqual(expect.arrayContaining(["Read", "WebSearch", "WebFetch"]));
    for (const write of WRITE_TOOLS) expect(tools).not.toContain(write);
    expect(skills).toEqual(["tavily"]);
  });
});

describe("region 17 · audit and research graphs", () => {
  it("[sma:k_ag_evalauditor] the eval review marks a flawed evaluation and offers the fix, a sound one is closed as sound with the review path", async () => {
    const review = await spawnOf("eval-review", "review");
    expect(review.spec).toMatchObject({ helper: "auditor", readOnly: true });
    expect(review.fields).toMatchObject({ findings: "array", review_path: "string", flawed: "boolean" });
    const flawed = await runSim("eval-review", { input: { phase_id: "ph_1" }, stubs: { review: { flawed: true, findings: [{ file: "evals/gold.json", line: 1, severity: "high", evidence: "gold set written after tuning" }], review_path: ".agents/phases/ph_1/EVAL-REVIEW.md", coverage: { latency: "missing" } } } });
    expect(pathOf(flawed)).toBe("review offer flawed");
    expect(out(flawed)).toMatchObject({ status: "flawed", review_path: ".agents/phases/ph_1/EVAL-REVIEW.md", proposed_workflow: "todo-add" });
    const sound = await runSim("eval-review", { input: { phase_id: "ph_1" }, stubs: { review: { flawed: false, findings: [], review_path: ".agents/phases/ph_1/EVAL-REVIEW.md" }, goal_check: { ok: true, verdict: "pass" } } });
    expect(out(sound)).toMatchObject({ status: "sound", review_path: ".agents/phases/ph_1/EVAL-REVIEW.md" });
    expect(pathOf(sound)).toBe("review goal_check sound");
  });

  it("[sma:k_ag_mapper] the analyze-code graph hands one scope to the analysis at the depth its mode asks for, and its recommendation is the summary of the report", async () => {
    const stubs = { analyze: { recommendation: "go_with_conditions", decisions: [{ id: "d1" }], risks: [], confidence: 77 }, report: { report_path: "reports/analysis-1.md" } };
    const standard = await runSim("analyze-code", { input: { goal: "map the writer", scope: "src/rooms/writer" }, stubs });
    expect(standard.called("analyze")[0]!.input).toMatchObject({ goal: "map the writer", scope: "src/rooms/writer", depth: "standard" });
    expect(out(standard)).toMatchObject({ status: "done", summary: "go_with_conditions", recommendation: "go_with_conditions", confidence: 77, report_path: "reports/analysis-1.md" });
    const quick = await runSim("analyze-code", { input: { goal: "map the writer", scope: "src/rooms/writer" }, mode: "quick", stubs });
    expect(quick.called("analyze")[0]!.input).toMatchObject({ depth: "quick" });
    const full = await runSim("analyze-code", { input: { goal: "map the writer", scope: "src/rooms/writer" }, mode: "full", stubs });
    expect(full.called("analyze")[0]!.input).toMatchObject({ depth: "deep" });
  });

  it("[sma:k_ag_assumptions] the grill sends a question without a code anchor back once, and the synthesis decides whether the plan is done or open", async () => {
    const walk = [{ questions_without_anchor: 2, branches_walked: 3, qa: [], terminology: [] }, { questions_without_anchor: 0, branches_walked: 3, qa: [], terminology: [{ term: "lane" }] }];
    const open = await runSim("grill-plan", { input: { goal: "g", plan: "p" }, stubs: { walk, synth: { locked: ["auth is in src/auth.ts:10"], open: ["cache size"], deferred: [], risk_register: [{ risk: "r" }] } } });
    expect(open.called("walk")).toHaveLength(2);
    expect(pathOf(open)).toBe("walk walk synth open");
    expect(out(open)).toMatchObject({ status: "open", locked: ["auth is in src/auth.ts:10"], open: ["cache size"], branches_walked: 3, terminology: [{ term: "lane" }] });
    const done = await runSim("grill-plan", { input: { goal: "g", plan: "p" }, stubs: { walk: walk[1]!, synth: { locked: ["a"], open: [], deferred: ["b"], risk_register: [] } } });
    expect(out(done)).toMatchObject({ status: "done", locked: ["a"], open: [], deferred: ["b"] });
    expect(done.called("walk")).toHaveLength(1);
  });

  it("[sma:k_ag_projres] the analysis puts the stack and the features the research step found into its result, before any roadmap is cut", async () => {
    const stubs = {
      gather: { anchors: [], modules: [], conventions: [], summary: "s", stack: ["ts", "node"], features: ["tasks", "phases"] },
      assess: { decisions: [], risks: [], scores_min: 3, scope_verdict: "small", recommendation: "go", confidence: 90, stalled: true, pressure_pass: true, open_questions: [], residual_risks: [], appetite: "s", no_gos: [], pitfalls: ["a race in the queue"] },
    };
    const r = await runSim("lp.analyze", { input: { goal: "g" }, stubs });
    expect(pathOf(r)).toBe("gather assess done");
    expect(out(r)).toMatchObject({ stack: ["ts", "node"], features: ["tasks", "phases"], pitfalls: ["a race in the queue"] });
  });

  it("[sma:k_ag_synth] the parallel researchers' sources are merged without duplicates and a question that found none is named, and the report is delivered where the run says", async () => {
    const rows = (...items: Array<{ item: unknown; data?: Record<string, unknown> }>) => {
      const all = items.map((entry, branch) => ({ branch, item: entry.item, ok: entry.data !== undefined, ...(entry.data ? { data: entry.data } : { error: "x", blocked: false }) }));
      return { rows: all, results: all.filter((row) => row.ok).map((row) => (row as { data: Record<string, unknown> }).data), failed: [], items: all.map((row) => row.item) } as never;
    };
    const merged = REDUCERS["reduce.web-research.search"]!(rows(
      { item: "q1", data: { subquestion: "q1", sources: [{ url: "u1" }, { url: "u2" }] } },
      { item: "q2", data: { subquestion: "q2", sources: [{ url: "u1" }] } },
      { item: "q3", data: { subquestion: "q3", sources: [] } },
    ));
    expect(merged).toEqual({ sources: [{ url: "u1" }, { url: "u2" }], source_count: 2, unavailable: ["q3"] });
    const r = await runSim("web-research", { input: { question: "what is lane pilot" }, stubs: {
      frame: { subquestions: ["a", "b"], sub_count: 2, needs_clarification: false },
      "search:child": { subquestion: "a", sources: [{ url: "https://x.test/a", title: "A" }] },
      claims: { claims: [{ id: 1 }], unverified: ["the date"], counter: [], claim_count: 1 },
      report: { report_md: "Short answer [1]", cited_ids: ["1"] }, check: { citation_ok: true, broken: [], unresolved: [] },
      deliver: { report_path: ".agents/research/research-1.md" }, goal_check: { ok: true, verdict: "pass" },
    } });
    expect(out(r)).toMatchObject({ status: "done", report_md: "Short answer [1]", unverified: ["the date"], report_path: ".agents/research/research-1.md", citation_ok: true });
    expect(out(r)!.sources).toEqual([{ url: "https://x.test/a", title: "A" }]);
  });

  it("[sma:k_ag_roadmapper] a roadmap the validator refuses is cut again by the same planner up to three times and then blocks, and an approved one runs its sessions", async () => {
    const goal = { goal: "g", requirements: "R1 login; R2 export" };
    const bad = await runSim("roadmap-driven", { input: goal, stubs: { roadmap: { sessions: [{ id: "s1" }], mode: "single", session_count: 1, requirement_map: { R1: [] } }, validate: { ok: false, errors: ["requirement R1 maps to no session"], cycles: [] } } });
    expect(bad.called("roadmap")).toHaveLength(3);
    expect(bad.called("validate")).toHaveLength(3);
    expect(out(bad)).toMatchObject({ status: "blocked" });
    const good = await runSim("roadmap-driven", { input: goal, stubs: {
      roadmap: { sessions: [{ id: "s1", intent: "login" }, { id: "s2", intent: "export" }], mode: "progressive", session_count: 2, requirement_map: { R1: ["s1"], R2: ["s2"] } },
      validate: { ok: true, errors: [], cycles: [] }, sessions: { done_ids: ["s1", "s2"], blocked_ids: [], done_count: 2, blocked_count: 0 }, close: { status: "closed", report_path: "reports/close.md" },
    }, humans: { approve: { answer: "approve", answer_kind: "approve" } } });
    expect(pathOf(good)).toContain("roadmap validate approve sessions close done");
    expect(out(good)).toMatchObject({ status: "done", sessions_total: 2, sessions_done: ["s1", "s2"], report_path: "reports/close.md" });
  });
});

describe("region 17 · the pattern mapper and the profiler", () => {
  const tasks = (...ids: string[]) => ids.map((id) => ({ id, objective: id }));

  it("[sma:k_ag_pattern] the closest-analog step feeds its patterns to the plan and the result when the phase asks for it, and runs in no quick plan", async () => {
    const stubs = { plan: { tasks: tasks("a", "b", "c"), task_count: 3 }, plan_critic: { status: "pass" }, patterns: { patterns_md: "src/rooms/x.ts:10 — copy its error handling" } };
    const on = await runSim("lp.plan", { input: { goal: "g", patterns: true }, stubs });
    expect(on.steps.filter((step) => step.state === "succeeded").map((step) => step.node_id)).toEqual(["patterns", "plan", "lint", "plan_critic", "ok"]);
    expect(on.called("plan")[0]!.input).toMatchObject({ patterns_md: "src/rooms/x.ts:10 — copy its error handling" });
    expect(out(on)).toMatchObject({ status: "ok", patterns_md: "src/rooms/x.ts:10 — copy its error handling" });
    const off = await runSim("lp.plan", { input: { goal: "g" }, stubs });
    expect(off.called("patterns")).toEqual([]);
    const quick = await runSim("lp.plan", { input: { goal: "g", patterns: true }, mode: "quick", stubs: { plan: stubs.plan } });
    expect(quick.called("patterns")).toEqual([]);
    expect(out(quick)).toMatchObject({ patterns_md: "" });
  });

  it("[sma:k_ag_profiler] fragments go to the model masked and numbered as data, and only a lasting fact about the person, said with enough confidence, becomes a kind; sensitive ones are marked", async () => {
    const prompts: string[] = [];
    const reply = JSON.stringify({ fragments: [
      { id: "f1", kind: "skill", about_owner: true, sensitive: false, confidence: "high" },
      { id: "f2", kind: "nothing", about_owner: false, sensitive: false, confidence: "high" },
      { id: "f3", kind: "fact", about_owner: true, sensitive: true, confidence: "medium" },
      { id: "f4", kind: "hobby", about_owner: true, sensitive: false, confidence: "low" },
    ] });
    const judge = fragmentJudgeVia(async (prompt) => { prompts.push(prompt); return reply; });
    const decisions = await judge(["I write TypeScript every day", "run the build again", "my daughter has asthma", "maybe I like chess"]);
    expect(decisions[0]).toEqual({ kind: "skill", kindP: 0.9, aboutOwner: 0.9, sensitive: 0 });
    expect(decisions[1]).toMatchObject({ kind: "nothing", aboutOwner: 0 });
    expect(decisions[2]).toEqual({ kind: "fact", kindP: 0.6, aboutOwner: 0.6, sensitive: 0.9 });
    expect(decisions[3]).toMatchObject({ kind: "nothing", kindP: 0.3 });
    expect(prompts[0]).toContain(JSON.stringify([{ id: "f1", text: "I write TypeScript every day" }, { id: "f2", text: "run the build again" }, { id: "f3", text: "my daughter has asthma" }, { id: "f4", text: "maybe I like chess" }]));
    // A reply that does not cover a fragment leaves it unread, and a failed call leaves every fragment unread.
    expect(parseFragments(JSON.stringify({ fragments: [{ id: "f2", kind: "skill", about_owner: true, confidence: "high" }] }), 2)).toEqual([null, { kind: "skill", kindP: 0.9, aboutOwner: 0.9, sensitive: 0 }]);
    expect(await fragmentJudgeVia(async () => { throw new Error("model down"); })(["a", "b"])).toEqual([null, null]);
  });
});
