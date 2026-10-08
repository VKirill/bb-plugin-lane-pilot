import { describe, expect, it } from "vitest";
import { MissingValueError, evalCondition, evalExpr, evalSpec, parseExpr, refOf, renderValue, valueSpecOf, ExprSyntaxError } from "@lane-pilot/workflow-engine";
import type { EvalEnv } from "@lane-pilot/workflow-engine";
import { normalizeWorkflow, parseTypeHint } from "@lane-pilot/workflow-engine";

/** A world of nodes that ran: `nodes[id]` is the latest output, absent means it has not run. */
const world = (nodes: Record<string, Record<string, unknown>>, extra: { inputs?: Record<string, unknown>; mode?: string; visits?: Record<string, number>; item?: unknown } = {}): EvalEnv => ({
  read: (ref) => {
    if (ref.kind === "node") { const output = nodes[ref.node!]; if (!output) return { ran: false, value: undefined }; return { ran: true, value: ref.path.reduce<unknown>((value, key) => (key === "length" && Array.isArray(value) ? value.length : (value as Record<string, unknown> | undefined)?.[key]), output) }; }
    if (ref.kind === "input") return { ran: true, value: ref.path.reduce<unknown>((value, key) => (key === "length" && Array.isArray(value) ? value.length : (value as Record<string, unknown> | undefined)?.[key]), extra.inputs ?? {}) };
    if (ref.kind === "mode") return { ran: true, value: extra.mode ?? "standard" };
    if (ref.kind === "item") return { ran: true, value: ref.path.reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], extra.item) };
    return { ran: false, value: undefined };
  },
  visits: (node) => extra.visits?.[node] ?? 0,
});
const holds = (text: string, env: EvalEnv, itemScope = false) => evalCondition(parseExpr(text, { itemScope }), env);

describe("expressions", () => {
  const env = world({ plan: { status: "ok", task_count: 4, has_ui: false, tasks: [1, 2, 3], ok: true }, check: { ok: false } }, { inputs: { goals: [1], tier: "deep", name: "", min: 10 }, mode: "full", visits: { fix: 1 } });

  it("compares, combines and negates", () => {
    expect(holds("plan.status == 'ok'", env)).toBe(true);
    expect(holds("plan.status != 'ok' || plan.task_count >= 4", env)).toBe(true);
    expect(holds("!plan.has_ui && plan.task_count > 3 && plan.task_count <= 4", env)).toBe(true);
    expect(holds("plan.status in ['ok','low_confidence']", env)).toBe(true);
    expect(holds("plan.status in [other, low]", env)).toBe(false);
    expect(holds("(!check.ok || plan.has_ui) && plan.ok", env)).toBe(true);
  });

  it("reads lengths, inputs, the mode and the visits of a node", () => {
    expect(holds("plan.tasks.length == 3", env)).toBe(true);
    expect(holds("$inputs.goals.length > 0", env)).toBe(true);
    expect(holds("$mode == 'full' && visits('fix') < 2 && visits('never') == 0", env)).toBe(true);
    expect(holds("$mode != 'quick'", env)).toBe(true);
    expect(evalExpr(parseExpr("plan.task_count + $inputs.min - 2"), env)).toBe(12);
  });

  it("treats a blank input as empty, as a spec condition like `$inputs.name != ''` means it", () => {
    expect(holds("$inputs.name != ''", env)).toBe(false);
    expect(holds("$inputs.absent == ''", env)).toBe(true);
    expect(holds("$inputs.min != ''", env)).toBe(true);
  });

  it("fails closed on a node that has not run, and never takes a missing number for 0", () => {
    expect(() => holds("nothing.status == 'ok'", env)).toThrow(MissingValueError);
    expect(() => holds("nothing.status == 'ok'", env)).toThrow(/has not produced status/);
    // A field the node left out compares as nothing: neither smaller nor larger.
    expect(holds("plan.score < 60", env)).toBe(false);
    expect(holds("plan.score >= 60", env)).toBe(false);
    // && and || read only what they need.
    expect(holds("visits('never') > 0 && nothing.status == 'ok'", env)).toBe(false);
    expect(holds("plan.ok || nothing.status == 'ok'", env)).toBe(true);
  });

  it("filters the items of a for_each with a condition on the item", () => {
    const filter = (item: unknown) => holds("severity in [critical, high] && file != ''", world({}, { item }), true);
    expect(filter({ severity: "high", file: "a.ts" })).toBe(true);
    expect(filter({ severity: "low", file: "a.ts" })).toBe(false);
  });

  it("refuses text it cannot read", () => {
    for (const text of ["a ==", "a && ", "a b", "(a", "'open", "a ? b : c", "visits(1", "1 +"]) expect(() => parseExpr(text), text).toThrow(ExprSyntaxError);
  });

  it("names the references: inputs, mode, context, item, variables, nodes", () => {
    expect(refOf("$inputs.a.b")).toEqual({ kind: "input", path: ["a", "b"] });
    expect(refOf("$mode")).toEqual({ kind: "mode", path: [] });
    expect(refOf("ctx.merged_commits")).toEqual({ kind: "ctx", path: ["merged_commits"] });
    expect(refOf("item.slug")).toEqual({ kind: "item", path: ["slug"] });
    expect(refOf("date")).toEqual({ kind: "var", path: ["date"] });
    expect(refOf("analyze")).toEqual({ kind: "node", node: "analyze", path: [] });
    expect(refOf("plan.tasks")).toEqual({ kind: "node", node: "plan", path: ["tasks"] });
  });
});

describe("values", () => {
  const env = world({ build: { merged_commits: ["a1", "b2"], status: "done" } }, { inputs: { goal: "ship it" }, mode: "full" });

  it("reads a value position by the spec's rules: quoted text, words, numbers, lists, expressions", () => {
    const value = (text: unknown) => evalSpec(valueSpecOf(text), env);
    expect(value("'roadmap.md'")).toBe("roadmap.md");
    expect(value("done")).toBe("done");
    expect(value("")).toBe("");
    expect(value("[]")).toEqual([]);
    expect(value("100")).toBe(100);
    expect(value(false)).toBe(false);
    expect(value("build.merged_commits")).toEqual(["a1", "b2"]);
    expect(value("build.merged_commits.length + 1")).toBe(3);
    expect(value("docs/specs/spec.md")).toBe("docs/specs/spec.md");
    expect(value("$inputs.goal")).toBe("ship it");
  });

  it("writes {{refs}} into a text, keeps the type of a lone one, and picks by_mode", () => {
    const read = (ref: Parameters<EvalEnv["read"]>[0]) => env.read(ref).value;
    expect(renderValue("goal: {{$inputs.goal}} / {{build.status}}", read, "full")).toBe("goal: ship it / done");
    expect(renderValue("{{build.merged_commits}}", read, "full")).toEqual(["a1", "b2"]);
    expect(renderValue({ depth: { by_mode: { quick: "quick", standard: "standard", full: "deep" } }, list: ["{{build.status}}"] }, read, "full")).toEqual({ depth: "deep", list: ["done"] });
    expect(renderValue({ by_mode: { quick: 1, default: 3 } }, read, "full")).toBe(3);
  });
});

describe("authoring spellings", () => {
  it("reads type hints", () => {
    expect(parseTypeHint("string")).toEqual({ type: "string" });
    expect(parseTypeHint("int")).toEqual({ type: "number" });
    expect(parseTypeHint("bool")).toEqual({ type: "boolean" });
    expect(parseTypeHint("Finding[]")).toEqual({ type: "array", ref: "Finding" });
    expect(parseTypeHint("string[][]")).toEqual({ type: "array" });
    expect(parseTypeHint("Verdict")).toEqual({ type: "object", ref: "Verdict" });
    expect(parseTypeHint("pass|rework|block")).toEqual({ type: "enum", values: ["pass", "rework", "block"] });
    expect(parseTypeHint("int|null")).toEqual({ type: "number", optional: true });
    expect(parseTypeHint("string|Finding[]")).toEqual({ type: "json" });
    expect(parseTypeHint("string?")).toEqual({ type: "string", optional: true });
    expect(parseTypeHint("any")).toEqual({ type: "json" });
  });

  it("normalizes the file spelling to the closed schema's", () => {
    const normalized = normalizeWorkflow({
      id: "x", name: "X", inputs: { goal: { type: "string", required: true }, tier: { type: "a|b", default: "a" }, scope: "string" },
      outputs: { status: "done|blocked", n: "int" }, budget: { max_steps: 5, max_minutes: 2, max_usd: 3, max_fan_out: 4 }, quality_mode: "full", triggers: ["chat"],
      nodes: [{ id: "n", type: "agent", out: { a: "int" }, guards: { maxVisits: 2, timeoutMin: 1 } }, { id: "act", type: "action", action: "fs.write", path: "p", files: ["f"] }, { id: "ask", type: "human", prompt: "Q?" }],
      edges: [{ from: "start", to: "n" }, { from: "n", to: "end" }],
    }) as { inputs: Array<Record<string, unknown>>; outputs: Array<Record<string, unknown>>; budget: Record<string, unknown>; guards: Record<string, unknown>; nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>>; name: unknown };
    expect(normalized.name).toEqual({ en: "X", ru: "X" });
    expect(normalized.inputs).toEqual([{ name: "goal", type: "string", required: true }, { name: "tier", type: "enum", values: ["a", "b"], required: false, default: "a" }, { name: "scope", type: "string", required: false }]);
    expect(normalized.outputs.map((field) => field.required)).toEqual([false, false]);
    expect(normalized.budget).toEqual({ maxSteps: 5, maxWallSeconds: 120, maxCostUsd: 3 });
    expect(normalized.guards).toEqual({ maxFanOut: 4 });
    expect(normalized.nodes[0]).toMatchObject({ out: [{ name: "a", type: "number", required: true }], maxVisits: 2, timeoutSec: 60 });
    expect(normalized.nodes[1]).toMatchObject({ params: { path: "p", files: ["f"] } });
    expect(normalized.nodes[2]).toMatchObject({ question: "Q?" });
    expect(normalized.edges).toEqual([{ from: "$start", to: "n" }, { from: "n", to: "$end" }]);
  });

  it("keeps `start` and `end` as node ids when a chain has nodes of that name", () => {
    const normalized = normalizeWorkflow({ id: "y", name: "Y", entry: "start", nodes: [{ id: "start", type: "action", action: "a" }, { id: "end", type: "action", action: "emit", map: {} }], edges: [{ from: "start", to: "end" }] }) as { edges: Array<Record<string, unknown>> };
    expect(normalized.edges).toEqual([{ from: "start", to: "end" }]);
  });
});
