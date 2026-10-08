import { describe, expect, it } from "vitest";
import { BUILTIN_SOURCES } from "../../src/workflow/builtin";
import { contractProblems, contractRepairPrompt, contractSample, describeProblems } from "../../src/workflow/contract";
import { lowerWorkflow } from "../../src/workflow/lower";
import { parseWorkflowObject } from "../../src/workflow/schema";
import { loadWorkflowStore } from "../../src/workflow/store";
import { loadWorkflow } from "../../src/workflow/validate";
import { codes, workflow } from "./fixtures";
import { engineOn, journalDb, ok, rows } from "./engine-helpers";
import { wf } from "./engine-helpers";

/** The step contract of a node (W0): consumes, produces, gates. */
type Row = Record<string, unknown>;
const agent = (id: string, extra: Row = {}) => ({ id, type: "agent", role: "analyst", prompt: `Do ${id}.`, ...extra });
const chain = (nodes: Row[], edges: Row[] = []) => workflow({
  inputs: [], outputs: [],
  nodes,
  edges: edges.length ? edges : nodes.flatMap((node, at) => [at === 0 ? { from: "start", to: node.id } : { from: nodes[at - 1]!.id, to: node.id }, ...(at === nodes.length - 1 ? [{ from: node.id, to: "end" }] : [])]),
});
const load = (source: unknown) => loadWorkflow(source);
const problemsOf = (source: unknown) => { const loaded = load(source); return loaded.ok ? loaded.warnings : loaded.problems; };

describe("the contract is part of the node's schema", () => {
  it("every runnable node takes consumes, produces and gates; an unknown key is still an error", () => {
    const parsed = parseWorkflowObject(chain([
      agent("a", { out: { summary: "string" }, produces: [{ kind: "summary", version: 1 }], gates: ["a.summary != ''"] }),
      { id: "b", type: "action", action: "x.y", consumes: [{ kind: "summary", version: 1, from: "a" }], out: { n: "int" } },
    ]));
    expect(parsed.success).toBe(true);
    const nodes = parsed.success ? parsed.data.nodes : [];
    expect(nodes[0]).toMatchObject({ produces: [{ kind: "summary", version: 1, required: true }], gates: ["a.summary != ''"] });
    // An action keeps its contract beside its params, not inside them.
    expect(nodes[1]).toMatchObject({ consumes: [{ kind: "summary", version: 1, required: true, from: "a" }] });
    expect(nodes[1] as Row).not.toHaveProperty("params.consumes");
    expect(parseWorkflowObject(chain([agent("a", { produces: [{ kind: "summary", version: 1, extra: 1 }] })])).success).toBe(false);
    expect(parseWorkflowObject(chain([agent("a", { produces: [{ kind: "Summary", version: 1 }] })])).success).toBe(false);
    expect(parseWorkflowObject(chain([agent("a", { gates: [""] })])).success).toBe(false);
  });

  it("a parallel node's contract belongs to its join; the fan-out has none", () => {
    const parsed = parseWorkflowObject(workflow({
      inputs: [{ name: "xs", type: "array" }], outputs: [],
      nodes: [{ id: "scan", type: "parallel", for_each: "$inputs.xs", produces: [{ kind: "findings", version: 1 }], gates: ["scan.findings.length >= 0"],
        child: agent("c", { out: { findings: "Finding[]" } }), join: { out: { findings: "Finding[]" } } }],
      edges: [{ from: "start", to: "scan" }, { from: "scan", to: "end" }],
    }));
    expect(parsed.success).toBe(true);
    const lowered = lowerWorkflow(parsed.success ? parsed.data : (undefined as never));
    const byId = Object.fromEntries(lowered.nodes.map((node) => [node.id, node as Row]));
    expect(byId["scan"]).toMatchObject({ type: "join", produces: [{ kind: "findings" }], gates: ["scan.findings.length >= 0"] });
    expect(byId["scan:fan"]).not.toHaveProperty("produces");
    expect(byId["scan:fan"]).not.toHaveProperty("gates");
  });
});

describe("the validator checks the contract", () => {
  it("warns on an agent or a code task that declares nothing it produces; says nothing once it does", () => {
    const bare = problemsOf(chain([agent("a", { out: { x: "int" } })]));
    expect(codes(bare, "warning")).toContain("contract_missing");
    expect(bare.find((problem) => problem.code === "contract_missing")!.node).toBe("a");
    expect(codes(problemsOf(chain([agent("a", { out: { x: "int" }, produces: [{ kind: "report", version: 1 }] })])), "warning")).not.toContain("contract_missing");
    // An action produces data by code and is not asked to declare it.
    expect(codes(problemsOf(chain([{ id: "a", type: "action", action: "x.y", out: { n: "int" } }])), "warning")).not.toContain("contract_missing");
  });

  it("refuses a kind that is not in the registry, a field the step does not declare and a kind whose fields the output lacks", () => {
    expect(codes(problemsOf(chain([agent("a", { produces: [{ kind: "poem", version: 1 }] })])))).toContain("artifact_unknown");
    expect(codes(problemsOf(chain([agent("a", { produces: [{ kind: "plan", version: 9 }] })])))).toContain("artifact_unknown");
    expect(codes(problemsOf(chain([agent("a", { out: { x: "int" }, produces: [{ kind: "plan", version: 1, field: "plan" }] })])))).toContain("produces_field");
    const missing = problemsOf(chain([agent("a", { out: { objective: "string" }, produces: [{ kind: "plan", version: 1 }] })])).find((problem) => problem.code === "produces_fields");
    expect(missing?.message).toContain("tasks");
    expect(codes(problemsOf(chain([agent("a", { out: { t: "string" }, produces: [{ kind: "task", version: 2, field: "t", each: true }] })])))).toContain("produces_field");
    expect(codes(problemsOf(chain([agent("a", { produces: [{ kind: "task", version: 2, each: true }] })])))).toContain("produces_each");
    // The handoff every agent carries satisfies `report/1` without declaring anything.
    expect(codes(problemsOf(chain([agent("a", { produces: [{ kind: "report", version: 1 }] })])), "error")).toEqual([]);
  });

  it("a consumer names a producer upstream that declares the same kind and version", () => {
    const base = (consumes: Row[], producerKind = "summary") => chain([
      agent("a", { out: { summary: "string" }, produces: [{ kind: producerKind, version: 1 }] }),
      agent("b", { consumes, produces: [{ kind: "report", version: 1 }] }),
    ]);
    expect(codes(problemsOf(base([{ kind: "summary", version: 1, from: "a" }])))).toEqual([]);
    expect(codes(problemsOf(base([{ kind: "summary", version: 1, from: "a" }], "report")))).toContain("consumes_mismatch");
    expect(codes(problemsOf(base([{ kind: "summary", version: 1, from: "nobody" }])))).toContain("consumes_from");
    expect(codes(problemsOf(base([{ kind: "verdict", version: 7 }])))).toContain("artifact_unknown");
    expect(codes(problemsOf(chain([agent("b", { consumes: [{ kind: "summary", version: 1, from: "a" }], produces: [{ kind: "report", version: 1 }] }), agent("a", { out: { summary: "string" }, produces: [{ kind: "summary", version: 1 }] })])))).toContain("consumes_order");
    expect(codes(problemsOf(base([{ kind: "summary", version: 1, from: "$inputs" }])))).toEqual([]);
  });

  it("a gate is a condition over the node's own declared fields", () => {
    const gate = (text: string) => codes(problemsOf(chain([agent("a", { out: { n: "int", s: "string" }, produces: [{ kind: "report", version: 1 }], gates: [text] })])));
    expect(gate("a.n >= 1 && a.s != ''")).toEqual([]);
    expect(gate("a.missing >= 1")).toContain("condition_field");
    expect(gate("a.n >=")).toContain("bad_expr");
    expect(gate("b.n >= 1")).toContain("condition");
  });
});

describe("what a step's output has to satisfy", () => {
  const node = { id: "a", produces: [{ kind: "findings", version: 1 }], gates: ["a.count == a.findings.length", "a.count <= 3"] };
  it("is nothing wrong for a valid artifact and gates that hold", () => {
    expect(contractProblems(node, { findings: [{ severity: "low", title: "t" }], count: 1 })).toEqual({ produces: [], gates: [] });
  });
  it("lists what the artifact lacks and which gate is not met", () => {
    const problems = contractProblems(node, { findings: [{ title: "t" }], count: 5 });
    expect(problems.produces[0]).toContain("findings.0.severity");
    expect(problems.gates).toEqual(["gate not met: a.count == a.findings.length", "gate not met: a.count <= 3"]);
  });
  it("a gate on a field the output does not have is not met, and a gate that cannot be evaluated says why", () => {
    expect(contractProblems({ id: "a", gates: ["a.n > 0"] }, {}).gates).toEqual(["gate not met: a.n > 0"]);
    expect(contractProblems({ id: "a", gates: ["b.n > 0"] }, { n: 1 }).gates[0]).toContain("cannot be read");
  });
  it("the repair turn names the problems, shows the shape and the fields, and says not to redo the work", () => {
    const text = contractRepairPrompt(contractProblems(node, { findings: [{ title: "t" }], count: 5 }), node.produces, "FIELDS CONTRACT");
    expect(text).toContain("does not meet this step's contract");
    expect(text).toContain("findings.0.severity");
    expect(text).toContain("gate not met: a.count <= 3");
    expect(text).toContain("Shape of findings/1");
    expect(text).toContain("\"severity\":\"high\"");
    expect(text).toContain("FIELDS CONTRACT");
    expect(text).toContain("do not redo the work");
    expect(describeProblems(contractProblems(node, { findings: [], count: 0 }))).toEqual([]);
  });
  it("a dry run answers from the registry's example where the output must be an artifact", () => {
    const fields = [{ name: "findings", type: "array" as const, required: true }, { name: "status", type: "enum" as const, values: ["done", "pass"], required: true }, { name: "n", type: "number" as const, required: true }];
    expect(contractSample([{ kind: "verdict", version: 1 }, { kind: "findings", version: 1 }], fields)).toEqual({ findings: [{ severity: "high", file: "src/a.ts", line: 12, title: "the limit is not checked", evidence: "if (n > 0) return n;" }] });
    // `status` of verdict/1 is "rework", which this node's enum does not allow: left to the made-up value.
  });
});

describe("the engine holds a step to its contract", () => {
  const definition = (extra: Row = {}) => wf({
    inputs: [{ name: "query", type: "string" }], outputs: [],
    nodes: [
      { id: "search", type: "action", action: "search", output: [{ name: "findings", type: "array" }, { name: "count", type: "number" }], produces: [{ kind: "findings", version: 1 }], gates: ["search.count == search.findings.length"], ...extra },
      { id: "write", type: "action", action: "write", output: [{ name: "text", type: "string" }] },
    ],
    edges: [{ from: "start", to: "search" }, { from: "search", to: "write" }, { from: "write", to: "end" }],
  });
  const good = ok(() => ({ findings: [{ severity: "low", title: "t" }], count: 1 }));
  const write = ok(() => ({ text: "w" }));

  it("a valid artifact passes", async () => {
    const summary = await engineOn(journalDb(), { search: good, write }).start({ workflow: definition(), inputs: { query: "q" } }).done;
    expect(summary.status).toBe("succeeded");
  });

  it("an output that is not the artifact is not a finished step: the run fails at it with artifact_invalid and the reason names the field", async () => {
    const db = journalDb();
    const bad = ok(() => ({ findings: [{ title: "no severity" }], count: 1 }));
    const summary = await engineOn(db, { search: bad, write }).start({ workflow: definition(), inputs: { query: "q" } }).done;
    expect(summary).toMatchObject({ status: "failed", failedNode: "search" });
    expect(summary.reason).toContain("artifact_invalid:search");
    expect(summary.error).toContain("findings.0.severity");
    expect(rows<{ state: string }>(db, "SELECT state FROM lane_pilot_wf_step WHERE run_id=? AND node_id='write'", summary.runId)).toEqual([]);
  });

  it("a gate that is not met fails the step with gate_failed", async () => {
    const summary = await engineOn(journalDb(), { search: ok(() => ({ findings: [], count: 2 })), write }).start({ workflow: definition(), inputs: { query: "q" } }).done;
    expect(summary.reason).toContain("gate_failed:search");
    expect(summary.error).toContain("search.count == search.findings.length");
  });

  it("maxAttempts gives the step another try, and a try that is right passes", async () => {
    let calls = 0;
    const flaky = ok(() => (++calls === 1 ? { findings: [{ title: "x" }], count: 1 } : { findings: [{ severity: "low", title: "x" }], count: 1 }));
    const summary = await engineOn(journalDb(), { search: flaky, write }).start({ workflow: definition({ maxAttempts: 2 }), inputs: { query: "q" } }).done;
    expect(summary.status).toBe("succeeded");
    expect(calls).toBe(2);
  });

  it("a step that is skipped is not held to what it would have produced", async () => {
    const skipped = wf({
      inputs: [{ name: "query", type: "string" }], outputs: [],
      nodes: [
        { id: "search", type: "action", action: "search", output: [{ name: "findings", type: "array" }], produces: [{ kind: "findings", version: 1 }], skip_when: "true" },
        { id: "write", type: "action", action: "write", output: [{ name: "text", type: "string" }] },
      ],
      edges: [{ from: "start", to: "search" }, { from: "search", to: "write" }, { from: "write", to: "end" }],
    });
    const summary = await engineOn(journalDb(), { search: good, write }).start({ workflow: skipped, inputs: { query: "q" } }).done;
    expect(summary.status).toBe("succeeded");
  });
});

describe("every shipped workflow declares its contracts", () => {
  it("each agent and code-task node produces an artifact of a registered kind, and the store loads them without a warning", async () => {
    const store = await loadWorkflowStore({ builtin: BUILTIN_SOURCES });
    expect(store.problems).toEqual([]);
    let nodes = 0;
    for (const item of store.list()) {
      expect(item.warnings, item.workflow.id).toEqual([]);
      const definition = item.workflow;
      const visit = (node: Row) => {
        if (node.type === "agent" || node.type === "lp-task") { nodes += 1; expect(node.produces, `${definition.id}.${String(node.id)}`).toBeDefined(); }
        if (node.child) visit(node.child as Row);
      };
      for (const node of definition.nodes) visit(node as unknown as Row);
    }
    expect(nodes).toBeGreaterThanOrEqual(100);
  });
});
