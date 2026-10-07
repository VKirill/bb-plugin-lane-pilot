import { describe, expect, it } from "vitest";
import { workflowSchema } from "../../src/workflow/schema";
import type { Workflow } from "../../src/workflow/schema";
import { loadWorkflow, outputFields, parseWorkflow, WorkflowError } from "../../src/workflow/validate";
import { codes, workflow } from "./fixtures";

const problems = (source: unknown, options = {}) => { const loaded = loadWorkflow(source, options); return loaded.ok ? loaded.warnings : loaded.problems; };

describe("workflow schema", () => {
  it("accepts a valid workflow and fills the defaults", () => {
    const parsed = parseWorkflow(workflow());
    expect(parsed.status).toBe("draft");
    expect(parsed.version).toBe(1);
    expect(parsed.guards).toEqual({ maxSteps: 60, maxFanOut: 12, maxSubworkflowDepth: 3 });
    expect(parsed.nodes[0]).toMatchObject({ id: "search", maxAttempts: 1 });
  });

  it("is closed: an unknown key is an error, at the top and in a node", () => {
    expect(workflowSchema.safeParse({ ...workflow(), colour: "red" }).success).toBe(false);
    const base = workflow();
    const node = { id: "x", type: "action", action: "x", typo: 1 };
    expect(codes(problems({ ...base, nodes: [node, ...(base.nodes as unknown[]).slice(1)] }))).toContain("schema");
  });

  it("needs both languages in the description and a known status", () => {
    expect(codes(problems({ ...workflow(), description: { en: "only" } }))).toContain("schema");
    expect(codes(problems({ ...workflow(), status: "ready" }))).toContain("schema");
    expect(parseWorkflow({ ...workflow(), status: "published" }).status).toBe("published");
  });

  it("reads JSON with comments and trailing commas, and reports a syntax error", () => {
    const text = `{ // note\n "schemaVersion": 1, "id": "demo", "name": "Demo", "description": {"en": "a", "ru": "б"},\n "nodes": [{"id":"a","type":"action","action":"a"},], "edges": [{"from":"start","to":"a"},{"from":"a","to":"end"}] }`;
    expect(parseWorkflow(text).id).toBe("demo");
    expect(codes(problems('{ "id": '))).toContain("syntax");
  });

  it("rejects an enum field without values and values on a non-enum", () => {
    const base = workflow();
    const bad = (field: unknown) => codes(problems({ ...base, inputs: [field] }));
    expect(bad({ name: "k", type: "enum" })).toContain("schema");
    expect(bad({ name: "k", type: "string", values: ["a"] })).toContain("schema");
  });
});

describe("conditions read only declared fields", () => {
  const withEdge = (when: unknown) => workflow({
    nodes: [...(workflow().nodes as unknown[]) as Array<Record<string, unknown>>],
    edges: [
      { from: "start", to: "search", with: { query: "input.query" } },
      { from: "search", to: "write", when },
      { from: "search", to: "end", with: { result: "input.query" } },
      { from: "write", to: "end", with: { result: "write.text" } },
    ],
  });

  it("accepts a condition on a declared number, enum and a length", () => {
    expect(codes(problems(withEdge({ field: "count", op: "gte", value: 5 })))).toEqual([]);
    expect(codes(problems(withEdge({ field: "kind", op: "eq", value: "fresh" })))).toEqual([]);
    expect(codes(problems(withEdge({ field: "items.length", op: "lt", value: 3 })))).toEqual([]);
    expect(codes(problems(withEdge({ all: [{ field: "kind", op: "in", value: ["fresh", "stale"] }, { not: { field: "count", op: "exists" } }] })))).toEqual([]);
  });

  it("makes a reference to a missing field a save error", () => {
    const result = problems(withEdge({ field: "score", op: "gte", value: 5 }));
    expect(codes(result)).toContain("condition_field");
    expect(result.find((problem) => problem.code === "condition_field")?.message).toContain("unknown field \"score\"");
    expect(() => parseWorkflow(withEdge({ field: "score", op: "gte", value: 5 }))).toThrow(WorkflowError);
  });

  it("checks the type of the field against the operator and the value", () => {
    expect(codes(problems(withEdge({ field: "kind", op: "gt", value: 1 })))).toContain("condition_type");
    expect(codes(problems(withEdge({ field: "count", op: "gt", value: "5" })))).toContain("condition_value");
    expect(codes(problems(withEdge({ field: "kind", op: "eq", value: "rotten" })))).toContain("condition_value");
    expect(codes(problems(withEdge({ field: "kind", op: "in", value: [] })))).toContain("condition_value");
    expect(codes(problems(withEdge({ field: "items", op: "eq", value: [] })))).toContain("condition_value");
  });

  it("checks the nested parts of all, any and not", () => {
    expect(codes(problems(withEdge({ any: [{ field: "count", op: "gt", value: 1 }, { not: { field: "nope", op: "exists" } }] })))).toContain("condition_field");
  });

  it("does not let a condition read a field of another node", () => {
    expect(codes(problems(withEdge({ field: "text", op: "exists" })))).toContain("condition_field");
  });

  it("does not let a condition be on the entry edge", () => {
    const base = workflow();
    expect(codes(problems({ ...base, edges: [{ from: "start", to: "search", when: { field: "query", op: "exists" } }, ...(base.edges as unknown[]).slice(1)] }))).toContain("entry");
  });
});

describe("graph shape", () => {
  it("needs one entry, one exit and no dead end", () => {
    const base = workflow();
    const edges = base.edges as unknown[];
    expect(codes(problems({ ...base, edges: edges.slice(1) }))).toContain("entry");
    expect(codes(problems({ ...base, edges: [edges[0], edges[1]] }))).toEqual(expect.arrayContaining(["dead_end", "no_exit"]));
  });

  it("rejects unknown endpoints, duplicate and reserved ids, edges of notes", () => {
    const base = workflow();
    const edges = base.edges as unknown[];
    expect(codes(problems({ ...base, edges: [...edges, { from: "write", to: "ghost" }] }))).toContain("edge_to");
    expect(codes(problems({ ...base, nodes: [...(base.nodes as unknown[]), { id: "write", type: "action" }] }))).toContain("duplicate_id");
    expect(codes(problems({ ...base, nodes: [...(base.nodes as unknown[]), { id: "item", type: "action" }] }))).toContain("reserved_id");
    expect(codes(problems({ ...base, nodes: [...(base.nodes as unknown[]), { id: "n", type: "note", text: "x" }], edges: [...edges, { from: "n", to: "end" }] }))).toContain("edge_note");
  });

  it("allows one unconditional fallback next to conditions, not several plain edges", () => {
    const base = workflow();
    const edges = base.edges as unknown[];
    expect(codes(problems({ ...base, edges: [...edges, { from: "search", to: "end", with: { result: "input.query" } }] }))).toContain("many_plain_edges");
  });

  it("warns about conditions without a fallback", () => {
    const base = workflow();
    const edges = base.edges as unknown[];
    const result = problems({ ...base, edges: [edges[0], { from: "search", to: "write", when: { field: "count", op: "gt", value: 1 } }, edges[2]] });
    expect(codes(result, "warning")).toContain("no_fallback");
  });

  it("makes a loop without maxVisits an error and accepts one with it", () => {
    const base = workflow();
    const loop = (maxVisits?: number) => ({
      ...base,
      nodes: [{ ...(base.nodes as Array<Record<string, unknown>>)[0], ...(maxVisits ? { maxVisits } : {}) }, (base.nodes as unknown[])[1]],
      edges: [
        { from: "start", to: "search", with: { query: "input.query" } },
        { from: "search", to: "write" },
        { from: "write", to: "search", when: { field: "text", op: "eq", value: "again" } },
        { from: "write", to: "end", with: { result: "write.text" } },
      ],
    });
    expect(codes(problems(loop()))).toContain("cycle_unbounded");
    expect(codes(problems(loop(3)))).toEqual([]);
  });

  it("requires the workflow outputs on the edge into end", () => {
    const base = workflow();
    const edges = base.edges as Array<Record<string, unknown>>;
    expect(codes(problems({ ...base, edges: [edges[0], edges[1], { from: "write", to: "end" }] }))).toContain("output_missing");
  });
});

describe("references", () => {
  it("accepts input, node and nested references and rejects a missing field, node or a node that runs later", () => {
    const base = workflow();
    const edges = base.edges as Array<Record<string, unknown>>;
    const withMap = (map: Record<string, string>) => problems({ ...base, edges: [edges[0], { ...edges[1], with: map }, edges[2]] });
    expect(codes(withMap({ a: "input.query", b: "search.items.length", c: "search.count" }))).toEqual([]);
    expect(codes(withMap({ a: "search.nothing" }))).toContain("bad_ref");
    expect(codes(withMap({ a: "ghost.x" }))).toContain("bad_ref");
    expect(codes(withMap({ a: "write.text" }))).toContain("bad_ref");
    expect(codes(withMap({ a: "justaword" }))).toContain("bad_ref");
    expect(codes(withMap({ a: "item" }))).toContain("bad_ref");
  });

  it("checks the placeholders of a prompt", () => {
    const base = workflow();
    const nodes = base.nodes as Array<Record<string, unknown>>;
    const withPrompt = (prompt: string) => problems({ ...base, nodes: [nodes[0], { id: "write", type: "agent", prompt, output: [{ name: "text", type: "string" }] }] });
    expect(codes(withPrompt("Write about {{input.query}} using {{search.items}}"))).toEqual([]);
    expect(codes(withPrompt("Use {{search.missing}}"))).toContain("bad_ref");
    expect(codes(withPrompt("Use {{write.text}}"))).toContain("bad_ref");
  });

  it("gives an agent a handoff field without declaring it", () => {
    const parsed = parseWorkflow(workflow({ nodes: [{ id: "search", type: "action", output: [{ name: "items", type: "array" }] }, { id: "write", type: "agent", prompt: "x", output: [{ name: "text", type: "string" }] }] }));
    expect(outputFields(parsed, parsed.nodes[1]!).map((field) => field.name)).toEqual(["text", "handoff"]);
    const withHandoff = workflow({
      nodes: [{ id: "search", type: "action" }, { id: "write", type: "agent", prompt: "x", output: [{ name: "text", type: "string" }] }],
      edges: [{ from: "start", to: "search" }, { from: "search", to: "write" }, { from: "write", to: "end", with: { result: "write.handoff" } }],
    });
    expect(codes(problems(withHandoff))).toEqual([]);
  });
});

describe("passing modes", () => {
  const agents = (pass: string, targetType = "agent") => workflow({
    nodes: [
      { id: "search", type: "agent", prompt: "x", output: [{ name: "items", type: "array" }] },
      targetType === "agent" ? { id: "write", type: "agent", prompt: "y", output: [{ name: "text", type: "string" }] } : { id: "write", type: "action", output: [{ name: "text", type: "string" }] },
    ],
    edges: [
      { from: "start", to: "search" },
      { from: "search", to: "write", pass },
      { from: "write", to: "end", with: { result: "write.text" } },
    ],
  });

  it("allows same-session, read-prior-session and fork between agents only", () => {
    for (const pass of ["same-session", "read-prior-session", "fork"]) expect(codes(problems(agents(pass)))).toEqual([]);
    expect(codes(problems(agents("fork", "action")))).toContain("pass_mode");
    expect(codes(problems(agents("copy")))).toContain("schema");
  });
});

describe("parallel and join", () => {
  const fan = (extra: Record<string, unknown> = {}, join: Record<string, unknown> | null = { id: "gather", type: "join", parallel: "split", output: [{ name: "results", type: "array" }] }) => workflow({
    nodes: [
      { id: "search", type: "action", output: [{ name: "items", type: "array" }] },
      { id: "split", type: "parallel", foreach: "search.items", ...extra },
      { id: "rate", type: "action", output: [{ name: "score", type: "number" }] },
      ...(join ? [join] : []),
    ],
    edges: [
      { from: "start", to: "search" },
      { from: "search", to: "split" },
      { from: "split", to: "rate" },
      { from: "rate", to: join ? "gather" : "end", with: { score: "rate.score" } },
      ...(join ? [{ from: "gather", to: "end", with: { result: "gather.results.length" } }] : []),
    ],
    outputs: [],
  });

  it("accepts a foreach with its join", () => {
    expect(codes(problems(fan()))).toEqual([]);
  });

  it("needs a join, a join of a parallel and a foreach of an array", () => {
    expect(codes(problems(fan({}, null)))).toEqual(expect.arrayContaining(["no_join"]));
    expect(codes(problems(fan({}, { id: "gather", type: "join", parallel: "search" })))).toEqual(expect.arrayContaining(["join_parallel", "no_join"]));
    expect(codes(problems(fan({ foreach: "search.items.length" })))).toContain("foreach_type");
  });

  it("does not allow a condition on a branch edge, nor a branch that escapes its join", () => {
    const base = fan({ foreach: undefined });
    const edges = (base.edges as Array<Record<string, unknown>>).map((edge) => edge.from === "split" ? { ...edge, when: { field: "x", op: "exists" } } : edge);
    expect(codes(problems({ ...base, edges }))).toContain("parallel_condition");
    const escape = workflow({
      nodes: [{ id: "split", type: "parallel" }, { id: "a", type: "action" }, { id: "b", type: "action" }, { id: "gather", type: "join", parallel: "split" }],
      edges: [{ from: "start", to: "split" }, { from: "split", to: "a" }, { from: "split", to: "b" }, { from: "a", to: "gather" }, { from: "b", to: "end" }, { from: "gather", to: "end" }],
      outputs: [],
    });
    expect(codes(problems(escape))).toEqual(expect.arrayContaining(["branch_escapes", "branch_no_join"]));
  });

  it("allows item and index inside a foreach branch only", () => {
    const base = fan();
    const edges = (base.edges as Array<Record<string, unknown>>).map((edge) => edge.from === "split" ? { ...edge, with: { thing: "item", n: "index" } } : edge);
    expect(codes(problems({ ...base, edges }))).toEqual([]);
  });
});

describe("subworkflows", () => {
  const child = (id: string, calls?: string): Workflow => parseWorkflow(workflow({
    id, inputs: [{ name: "query", type: "string" }], outputs: [{ name: "result", type: "string" }],
    nodes: calls
      ? [{ id: "call", type: "subworkflow", workflow: calls, inputs: { query: "input.query" }, output: [{ name: "result", type: "string" }] }]
      : [{ id: "write", type: "action", output: [{ name: "result", type: "string" }] }],
    edges: calls
      ? [{ from: "start", to: "call" }, { from: "call", to: "end", with: { result: "call.result" } }]
      : [{ from: "start", to: "write" }, { from: "write", to: "end", with: { result: "write.result" } }],
  }));
  const parent = (calls: string) => workflow({
    nodes: [{ id: "call", type: "subworkflow", workflow: calls, inputs: { query: "input.query" }, output: [{ name: "result", type: "string" }] }],
    edges: [{ from: "start", to: "call" }, { from: "call", to: "end", with: { result: "call.result" } }],
  });
  const registry = (...items: Workflow[]) => ({ resolve: (id: string) => items.find((item) => item.id === id) ?? null });

  it("accepts a call whose child exists and whose inputs and outputs match", () => {
    expect(codes(problems(parent("leaf"), registry(child("leaf"))))).toEqual([]);
  });

  it("rejects a missing child, an unmapped input and an output the child lacks", () => {
    expect(codes(problems(parent("ghost"), registry(child("leaf"))))).toContain("subworkflow_missing");
    const wrongInput = workflow({
      nodes: [{ id: "call", type: "subworkflow", workflow: "leaf", inputs: {}, output: [{ name: "result", type: "string" }] }],
      edges: [{ from: "start", to: "call" }, { from: "call", to: "end", with: { result: "call.result" } }],
    });
    expect(codes(problems(wrongInput, registry(child("leaf"))))).toContain("subworkflow_input");
    const wrongOutput = workflow({
      nodes: [{ id: "call", type: "subworkflow", workflow: "leaf", inputs: { query: "input.query" }, output: [{ name: "other", type: "string" }] }],
      edges: [{ from: "start", to: "call" }, { from: "call", to: "end", with: { result: "input.query" } }],
    });
    expect(codes(problems(wrongOutput, registry(child("leaf"))))).toContain("subworkflow_output");
  });

  it("allows a chain of three calls and rejects four, and a recursion", () => {
    const chain = [child("w3"), child("w2", "w3"), child("w1", "w2")];
    expect(codes(problems(parent("w1"), registry(...chain)))).toEqual([]);
    const four = [...chain, child("w0", "w1")];
    expect(codes(problems(parent("w0"), registry(...four)))).toContain("subworkflow_depth");
    const loop = [child("ping", "pong"), child("pong", "ping")];
    expect(codes(problems(parent("ping"), registry(...loop)))).toContain("subworkflow_cycle");
  });
});

describe("humans and executors", () => {
  it("needs a default option from the options when a human defaults on timeout", () => {
    const human = (extra: Record<string, unknown>) => workflow({
      nodes: [{ id: "ask", type: "human", question: "Go on?", options: ["yes", "no"], output: [{ name: "answer", type: "string" }], ...extra }],
      edges: [{ from: "start", to: "ask" }, { from: "ask", to: "end", with: { result: "ask.answer" } }],
    });
    expect(codes(problems(human({ onTimeout: "default", defaultOption: "yes" })))).toEqual([]);
    expect(codes(problems(human({ onTimeout: "default", defaultOption: "maybe" })))).toContain("human_default");
  });

  it("checks executor keys when the registry is known", () => {
    const base = workflow({ nodes: [{ id: "search", type: "action", uses: "ghost.exec" }, { id: "write", type: "action" }] });
    expect(codes(problems(base, { hasExecutor: () => false }))).toContain("executor_missing");
    expect(codes(problems(base))).not.toContain("executor_missing");
  });
});
