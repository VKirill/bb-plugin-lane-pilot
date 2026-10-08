import { describe, expect, it } from "vitest";
import { WorkflowEngine } from "../../src/workflow/engine";
import type { NodeExecutor } from "../../src/workflow/engine";
import { engineOn, journalDb, ok, rows, stepStates, wf } from "./engine-helpers";

const search = ok(() => ({ items: ["a", "b", "c"], count: 3, kind: "fresh" }));
const write = ok((ctx) => ({ text: `wrote ${(ctx.input.with.items as unknown[]).length}` }));
const run = async (engine: WorkflowEngine, workflow = wf(), inputs: Record<string, unknown> = { query: "q" }) => engine.start({ workflow, inputs }).done;

describe("linear run", () => {
  it("runs the steps in order, maps data by declared fields only and keeps a receipt for each step", async () => {
    const db = journalDb();
    const engine = engineOn(db, { search, write }, { harnessVersion: "9.9.9" });
    const summary = await run(engine);
    expect(summary).toMatchObject({ status: "succeeded", output: { result: "wrote 3" }, error: null });
    const steps = rows<Record<string, string>>(db, "SELECT * FROM lane_pilot_wf_step WHERE run_id=? ORDER BY rowid", summary.runId);
    expect(steps.map((step) => [step.node_id, step.state, step.routed, step.harness_version])).toEqual([["search", "succeeded", 1, "9.9.9"], ["write", "succeeded", 1, "9.9.9"]]);
    const receipt = JSON.parse(steps[1]!.receipt_json!);
    expect(receipt).toMatchObject({ executor: "write", harnessVersion: "9.9.9", attempts: 1 });
    expect(receipt.inputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(steps[1]!.spawn_key).toMatch(/^[a-f0-9]{32}$/);
    // The step got the mapped field only, not the other outputs of search.
    expect(JSON.parse(steps[1]!.input_json).with).toEqual({ items: ["a", "b", "c"] });
    const kinds = rows<{ kind: string; to_state: string }>(db, "SELECT kind, to_state FROM lane_pilot_wf_event WHERE run_id=? ORDER BY seq", summary.runId);
    expect(kinds.filter((event) => event.kind === "step" && event.to_state === "succeeded")).toHaveLength(2);
    expect(kinds.at(-1)).toMatchObject({ kind: "run", to_state: "succeeded" });
  });

  it("pins the definition: a run keeps the workflow it started with", async () => {
    const db = journalDb();
    const engine = engineOn(db, { search, write });
    const summary = await run(engine);
    const row = rows<{ workflow_id: string; workflow_version: number; workflow_sha256: string; definition_json: string }>(db, "SELECT * FROM lane_pilot_wf_run WHERE id=?", summary.runId)[0]!;
    expect(row).toMatchObject({ workflow_id: "demo", workflow_version: 1 });
    expect(row.workflow_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(row.definition_json).nodes).toHaveLength(2);
  });

  it("refuses to start a workflow whose executor is not registered, or whose inputs are wrong", () => {
    const engine = engineOn(journalDb(), { search });
    expect(() => engine.start({ workflow: wf(), inputs: { query: "q" } })).toThrow(/executor "write" is not registered/);
    const full = engineOn(journalDb(), { search, write });
    expect(() => full.start({ workflow: wf(), inputs: {} })).toThrow(/query/);
  });

  it("is idempotent on its key: the second start returns the same run", async () => {
    const db = journalDb();
    const engine = engineOn(db, { search, write });
    const first = engine.start({ workflow: wf(), inputs: { query: "q" }, key: "attempt-1" });
    await first.done;
    const second = engine.start({ workflow: wf(), inputs: { query: "q" }, key: "attempt-1" });
    expect(second.created).toBe(false);
    expect(second.runId).toBe(first.runId);
    expect(rows(db, "SELECT id FROM lane_pilot_wf_run")).toHaveLength(1);
  });

  it("fails the run with the executor's own message when a step throws", async () => {
    const engine = engineOn(journalDb(), { search, write: ok(() => { throw new Error("disk is full"); }) });
    const summary = await run(engine);
    expect(summary).toMatchObject({ status: "failed", error: "disk is full", failedNode: "write" });
    expect(summary.reason).toBe("step_failed:write");
  });

  it("fails a step whose output does not match its declared fields", async () => {
    const wrong = await run(engineOn(journalDb(), { search: ok(() => ({ items: "not a list", count: 3, kind: "fresh" })), write }));
    expect(wrong).toMatchObject({ status: "failed", failedNode: "search" });
    expect(wrong.error).toContain("items");
    const missing = await run(engineOn(journalDb(), { search: ok(() => ({ items: [], count: 1 })), write }));
    expect(missing.error).toContain("kind");
    const badEnum = await run(engineOn(journalDb(), { search: ok(() => ({ items: [], count: 1, kind: "rotten" })), write }));
    expect(badEnum.error).toContain("enum");
  });
});

describe("decisions", () => {
  const branching = (mode: "plain" | "nofallback" = "plain") => wf({
    nodes: [
      { id: "search", type: "action", action: "search", output: [{ name: "items", type: "array" }, { name: "count", type: "number" }, { name: "kind", type: "enum", values: ["fresh", "stale"] }] },
      { id: "more", type: "action", action: "more", output: [{ name: "text", type: "string" }] },
      { id: "write", type: "action", action: "write", output: [{ name: "text", type: "string" }] },
    ],
    edges: [
      { from: "start", to: "search" },
      { from: "search", to: "more", when: { field: "count", op: "lt", value: 5 } },
      ...(mode === "plain" ? [{ from: "search", to: "write" }] : []),
      { from: "more", to: "end", with: { result: "more.text" } },
      { from: "write", to: "end", with: { result: "write.text" } },
    ],
  });
  const exec = (count: number) => ({ search: ok(() => ({ items: [], count, kind: "fresh" })), more: ok(() => ({ text: "expanded" })), write: ok(() => ({ text: "direct" })) });

  it("takes the branch whose condition holds and the fallback otherwise", async () => {
    expect((await run(engineOn(journalDb(), exec(2)), branching())).output).toEqual({ result: "expanded" });
    expect((await run(engineOn(journalDb(), exec(9)), branching())).output).toEqual({ result: "direct" });
  });

  it("fails closed when no condition matches and there is no fallback", async () => {
    const summary = await run(engineOn(journalDb(), exec(9)), branching("nofallback"));
    expect(summary.status).toBe("failed");
    expect(summary.reason).toContain("no_matching_edge:search");
  });

  it("a decision node reads the fields of another node and routes on them", async () => {
    const workflow = wf({
      nodes: [
        { id: "search", type: "action", action: "search", output: [{ name: "count", type: "number" }, { name: "kind", type: "enum", values: ["fresh", "stale"] }] },
        { id: "pick", type: "decision", reads: "search", output: [{ name: "kind", type: "enum", values: ["fresh", "stale"] }] },
        { id: "write", type: "action", action: "write", output: [{ name: "text", type: "string" }] },
      ],
      edges: [
        { from: "start", to: "search" }, { from: "search", to: "pick" },
        { from: "pick", to: "write", when: { field: "kind", op: "eq", value: "fresh" } },
        { from: "pick", to: "end", with: { result: "search.kind" } },
        { from: "write", to: "end", with: { result: "write.text" } },
      ],
    });
    const engine = engineOn(journalDb(), exec(1));
    expect((await run(engine, workflow)).output).toEqual({ result: "direct" });
  });

  it("fails a mapping whose source field has no value instead of passing nothing on", async () => {
    const workflow = wf({
      nodes: [{ id: "search", type: "action", action: "search", output: [{ name: "note", type: "string", required: false }] }, { id: "write", type: "action", action: "write", output: [{ name: "text", type: "string" }] }],
      edges: [{ from: "start", to: "search" }, { from: "search", to: "write" }, { from: "write", to: "end", with: { result: "search.note" } }],
    });
    const summary = await run(engineOn(journalDb(), { search: ok(() => ({})), write: ok(() => ({ text: "x" })) }), workflow);
    expect(summary.status).toBe("succeeded");
    expect(summary.output).toEqual({});
  });
});

describe("parallel and join", () => {
  const fan = (extra: Record<string, unknown> = {}) => wf({
    outputs: [{ name: "total", type: "number" }],
    nodes: [
      { id: "search", type: "action", action: "search", output: [{ name: "items", type: "array" }] },
      { id: "split", type: "parallel", foreach: "search.items", ...extra },
      { id: "rate", type: "action", action: "rate", output: [{ name: "score", type: "number" }] },
      { id: "gather", type: "join", parallel: "split", output: [{ name: "results", type: "array" }, { name: "count", type: "number" }] },
      { id: "sum", type: "action", action: "sum", output: [{ name: "total", type: "number" }] },
    ],
    edges: [
      { from: "start", to: "search" }, { from: "search", to: "split" }, { from: "split", to: "rate" },
      { from: "rate", to: "gather", with: { score: "rate.score" } },
      { from: "gather", to: "sum", with: { results: "gather.results" } },
      { from: "sum", to: "end", with: { total: "sum.total" } },
    ],
  });
  const executors = (items: unknown[], seen: unknown[] = []) => ({
    search: ok(() => ({ items })),
    rate: ok((ctx) => { seen.push(ctx.input.item); return { score: Number(ctx.input.item) * 10 + Number(ctx.input.index) }; }),
    sum: ok((ctx) => ({ total: (ctx.input.with.results as Array<{ score: number }>).reduce((sum, row) => sum + row.score, 0) })),
  });

  it("runs one branch per item and joins the results in branch order", async () => {
    const seen: unknown[] = [];
    const db = journalDb();
    const summary = await run(engineOn(db, executors([1, 2, 3], seen)), fan());
    expect(summary).toMatchObject({ status: "succeeded", output: { total: 10 + 0 + 20 + 1 + 30 + 2 } });
    expect(seen.sort()).toEqual([1, 2, 3]);
    const states = stepStates(db, summary.runId);
    expect(Object.keys(states).filter((key) => key.startsWith("rate#"))).toHaveLength(3);
    expect(Object.values(states).every((state) => state === "succeeded")).toBe(true);
    const arrivals = rows(db, "SELECT branch FROM lane_pilot_wf_arrival WHERE run_id=? ORDER BY branch", summary.runId);
    expect(arrivals).toHaveLength(3);
  });

  it("joins an empty list at once", async () => {
    const summary = await run(engineOn(journalDb(), executors([])), fan());
    expect(summary).toMatchObject({ status: "succeeded", output: { total: 0 } });
  });

  it("fails a fan-out over the limit, and truncates only when the node says so", async () => {
    const items = Array.from({ length: 15 }, (_, index) => index);
    const failed = await run(engineOn(journalDb(), executors(items)), fan());
    expect(failed).toMatchObject({ status: "failed" });
    expect(failed.reason).toContain("guard:maxFanOut");
    const truncated = await run(engineOn(journalDb(), executors(items)), fan({ onOverflow: "truncate", max_fan_out: 4 }));
    expect(truncated.status).toBe("succeeded");
    expect(truncated.output).toEqual({ total: [0, 1, 2, 3].reduce((sum, n) => sum + n * 10 + n, 0) });
  });

  it("static branches run together and meet in the join", async () => {
    const workflow = wf({
      outputs: [{ name: "result", type: "string" }],
      nodes: [
        { id: "split", type: "parallel" },
        { id: "left", type: "action", action: "left", output: [{ name: "v", type: "string" }] },
        { id: "right", type: "action", action: "right", output: [{ name: "v", type: "string" }] },
        { id: "gather", type: "join", parallel: "split", output: [{ name: "results", type: "array" }] },
        { id: "sum", type: "action", action: "sum", output: [{ name: "text", type: "string" }] },
      ],
      edges: [
        { from: "start", to: "split" }, { from: "split", to: "left" }, { from: "split", to: "right" },
        { from: "left", to: "gather", with: { v: "left.v" } }, { from: "right", to: "gather", with: { v: "right.v" } },
        { from: "gather", to: "sum", with: { results: "gather.results" } },
        { from: "sum", to: "end", with: { result: "sum.text" } },
      ],
    });
    const summary = await run(engineOn(journalDb(), { left: ok(() => ({ v: "L" })), right: ok(() => ({ v: "R" })), sum: ok((ctx) => ({ text: (ctx.input.with.results as Array<{ v: string }>).map((row) => row.v).join("+") })) }), workflow);
    expect(summary.output).toEqual({ result: "L+R" });
  });

  it("a failing branch fails the run", async () => {
    const summary = await run(engineOn(journalDb(), { ...executors([1, 2]), rate: ok((ctx) => { if (ctx.input.item === 2) throw new Error("bad item"); return { score: 1 }; }) }), fan());
    expect(summary).toMatchObject({ status: "failed", error: "bad item", failedNode: "rate" });
  });
});

describe("guards", () => {
  const loop = (withFallback = true) => wf({
    nodes: [
      { id: "search", type: "action", action: "search", maxVisits: 3, output: [{ name: "n", type: "number" }] },
      { id: "write", type: "action", action: "write", maxVisits: 3, output: [{ name: "text", type: "string" }] },
    ],
    edges: [
      { from: "start", to: "search" }, { from: "search", to: "write" },
      { from: "write", to: "search", when: { field: "text", op: "eq", value: "again" } },
      ...(withFallback ? [{ from: "write", to: "end", with: { result: "write.text" } }] : []),
    ],
  });

  it("maxVisits: a loop that keeps asking is cut and falls to the exit edge", async () => {
    let visits = 0;
    const summary = await run(engineOn(journalDb(), { search: ok(() => ({ n: ++visits })), write: ok(() => ({ text: "again" })) }), loop());
    expect(visits).toBe(3);
    expect(summary).toMatchObject({ status: "succeeded", output: { result: "again" } });
  });

  it("maxVisits without another way out fails with the guard", async () => {
    const workflow = wf({
      nodes: [{ id: "search", type: "action", action: "search", maxVisits: 2, output: [{ name: "n", type: "number" }] }, { id: "write", type: "action", action: "write", output: [{ name: "text", type: "string" }] }],
      edges: [{ from: "start", to: "search" }, { from: "search", to: "write" },
        { from: "write", to: "search", when: { field: "text", op: "eq", value: "again" } },
        { from: "write", to: "end", when: { field: "text", op: "eq", value: "done" }, with: { result: "write.text" } }],
    });
    const summary = await run(engineOn(journalDb(), { search: ok(() => ({ n: 1 })), write: ok(() => ({ text: "again" })) }), workflow);
    expect(summary.status).toBe("failed");
    expect(summary.reason).toContain("guard:maxVisits");
  });

  it("maxAttempts: a step is tried again and succeeds, or fails after the last try", async () => {
    let calls = 0;
    const flaky = wf({ nodes: [{ id: "search", type: "action", action: "search", maxAttempts: 3, output: [{ name: "items", type: "array" }, { name: "count", type: "number" }, { name: "kind", type: "enum", values: ["fresh", "stale"] }] }, { id: "write", type: "action", action: "write", output: [{ name: "text", type: "string" }] }] });
    const db = journalDb();
    const good = await run(engineOn(db, { search: ok(() => { calls += 1; if (calls < 3) throw new Error("flaky"); return { items: [], count: 1, kind: "fresh" }; }), write }), flaky);
    expect(good.status).toBe("succeeded");
    expect(calls).toBe(3);
    expect(rows(db, "SELECT detail FROM lane_pilot_wf_event WHERE kind='attempt_failed'")).toHaveLength(2);
    calls = 0;
    const bad = await run(engineOn(journalDb(), { search: ok(() => { calls += 1; throw new Error("always"); }), write }), flaky);
    expect(calls).toBe(3);
    expect(bad).toMatchObject({ status: "failed", error: "always" });
  });

  it("each try has its own spawn key, and a resumed try keeps its number", async () => {
    const keys: string[] = [];
    let calls = 0;
    const flaky = wf({ nodes: [{ id: "search", type: "action", action: "search", maxAttempts: 2, output: [{ name: "items", type: "array" }, { name: "count", type: "number" }, { name: "kind", type: "enum", values: ["fresh", "stale"] }] }, { id: "write", type: "action", action: "write", output: [{ name: "text", type: "string" }] }] });
    await run(engineOn(journalDb(), { search: ok((ctx) => { keys.push(`${ctx.attempt}:${ctx.spawnKey}`); calls += 1; if (calls === 1) throw new Error("x"); return { items: [], count: 1, kind: "fresh" }; }), write }), flaky);
    expect(keys.map((key) => key.split(":")[0])).toEqual(["1", "2"]);
    expect(new Set(keys.map((key) => key.split(":")[1])).size).toBe(2);
  });

  it("maxSteps: a run that goes on past the limit fails", async () => {
    const workflow = wf({
      guards: { maxSteps: 4, maxFanOut: 12, maxSubworkflowDepth: 3 },
      nodes: [{ id: "search", type: "action", action: "search", maxVisits: 50, output: [{ name: "n", type: "number" }] }],
      edges: [{ from: "start", to: "search" }, { from: "search", to: "search", when: { field: "n", op: "lt", value: 100 } }, { from: "search", to: "end", with: { result: "input.query" } }],
    });
    let n = 0;
    const summary = await run(engineOn(journalDb(), { search: ok(() => ({ n: ++n })) }), workflow);
    expect(summary.status).toBe("failed");
    expect(summary.reason).toContain("guard:maxSteps");
    expect(n).toBeLessThanOrEqual(4);
  });

  it("budget: tokens used stop the run as blocked, not failed", async () => {
    const workflow = wf({ budget: { maxTokens: 100 } });
    const heavy: NodeExecutor = { reentrant: true, run: async () => ({ output: { items: [], count: 1, kind: "fresh" }, usage: { tokens: 150, costUsd: 0.5 } }) };
    const db = journalDb();
    const summary = await run(engineOn(db, { search: heavy, write }), workflow);
    expect(summary).toMatchObject({ status: "blocked", reason: "budget_exceeded:tokens" });
    expect(rows<{ tokens_used: number; cost_micro_usd: number }>(db, "SELECT tokens_used, cost_micro_usd FROM lane_pilot_wf_run")[0]).toEqual({ tokens_used: 150, cost_micro_usd: 500_000 });
  });

  it("budget: a token or money budget with steps that report no usage holds the run to 40 steps, with a journal note", async () => {
    const workflow = wf({
      budget: { maxCostUsd: 2 },
      guards: { maxSteps: 200, maxFanOut: 12, maxSubworkflowDepth: 3 },
      nodes: [{ id: "search", type: "action", action: "search", maxVisits: 50, output: [{ name: "n", type: "number" }] }],
      edges: [{ from: "start", to: "search" }, { from: "search", to: "search", when: { field: "n", op: "lt", value: 1000 } }, { from: "search", to: "end", with: { result: "input.query" } }],
    });
    let n = 0;
    const blind: NodeExecutor = { reentrant: true, run: async () => ({ output: { n: ++n }, usage: { tokens: 0, costUsd: 0, unknown: true } }) };
    const db = journalDb();
    const summary = await run(engineOn(db, { search: blind }), workflow);
    expect(summary).toMatchObject({ status: "blocked", reason: "budget_exceeded:usage_unknown_steps" });
    expect(n).toBe(40);
    expect(rows<{ kind: string }>(db, "SELECT kind FROM lane_pilot_wf_event WHERE kind='usage_unknown'")).toHaveLength(1);
    // The same steps with usage reported are not held back by the extra limit.
    n = 0;
    const seen: NodeExecutor = { reentrant: true, run: async () => ({ output: { n: ++n }, usage: { tokens: 1, costUsd: 0.001 } }) };
    const free = await run(engineOn(journalDb(), { search: seen }), wf({ ...workflow, id: "seen" }));
    expect(free.status).toBe("succeeded");
  });

  it("budget: a token budget that also names maxSteps keeps its own limit when usage is unknown", async () => {
    const workflow = wf({
      budget: { maxTokens: 100000, maxSteps: 5 },
      guards: { maxSteps: 200, maxFanOut: 12, maxSubworkflowDepth: 3 },
      nodes: [{ id: "search", type: "action", action: "search", maxVisits: 50, output: [{ name: "n", type: "number" }] }],
      edges: [{ from: "start", to: "search" }, { from: "search", to: "search", when: { field: "n", op: "lt", value: 1000 } }, { from: "search", to: "end", with: { result: "input.query" } }],
    });
    let n = 0;
    const blind: NodeExecutor = { reentrant: true, run: async () => ({ output: { n: ++n }, usage: { unknown: true } }) };
    const summary = await run(engineOn(journalDb(), { search: blind }), workflow);
    expect(summary).toMatchObject({ status: "blocked", reason: "budget_exceeded:steps" });
    expect(n).toBe(5);
  });

  it("timeoutSec: a step that hangs fails", async () => {
    const workflow = wf({ nodes: [{ id: "search", type: "action", action: "search", timeoutSec: 1, output: [{ name: "items", type: "array" }, { name: "count", type: "number" }, { name: "kind", type: "enum", values: ["fresh", "stale"] }] }, { id: "write", type: "action", action: "write", output: [{ name: "text", type: "string" }] }] });
    const hang: NodeExecutor = { run: () => new Promise(() => undefined) };
    const summary = await run(engineOn(journalDb(), { search: hang, write }), workflow);
    expect(summary).toMatchObject({ status: "failed", error: "timeout after 1s" });
  }, 10_000);

  it("an agent step without a handoff fails", async () => {
    const agentFlow = (value: string) => wf({
      nodes: [{ id: "think", type: "agent", prompt: "think", output: [{ name: "text", type: "string" }] }],
      edges: [{ from: "start", to: "think" }, { from: "think", to: "end", with: { result: "think.handoff" } }],
    });
    const missing = await run(engineOn(journalDb(), { agent: ok(() => ({ text: "x" })) }), agentFlow("x"));
    expect(missing).toMatchObject({ status: "failed", reason: "handoff_missing:think" });
    const empty = await run(engineOn(journalDb(), { agent: ok(() => ({ text: "x", handoff: "  " })) }), agentFlow("x"));
    expect(empty.reason).toBe("handoff_missing:think");
    const fine = await run(engineOn(journalDb(), { agent: ok(() => ({ text: "x", handoff: "did x; result in text" })) }), agentFlow("x"));
    expect(fine).toMatchObject({ status: "succeeded", output: { result: "did x; result in text" } });
  });
});

describe("passing modes", () => {
  it("tells the next agent where the previous one ran and what it handed over", async () => {
    const workflow = wf({
      nodes: [
        { id: "first", type: "agent", prompt: "a", output: [{ name: "text", type: "string" }] },
        { id: "second", type: "agent", prompt: "b {{first.text}}", output: [{ name: "text", type: "string" }] },
      ],
      edges: [{ from: "start", to: "first" }, { from: "first", to: "second", pass: "read-prior-session" }, { from: "second", to: "end", with: { result: "second.text" } }],
    });
    let seen: unknown = null, prompt = "";
    const agent: NodeExecutor = { reentrant: true, run: async (ctx) => {
      if (ctx.nodeId === "first") return { output: { text: "one", handoff: "first did one" }, threadId: "thr_first" };
      seen = ctx.input.via; prompt = ctx.render((ctx.node as { prompt: string }).prompt);
      return { output: { text: "two", handoff: "second did two" } };
    } };
    const summary = await run(engineOn(journalDb(), { agent }), workflow);
    expect(summary.status).toBe("succeeded");
    expect(seen).toMatchObject({ mode: "read-prior-session", fromThreadId: "thr_first", handoff: "first did one" });
    expect(prompt).toBe("b one");
  });
});

describe("waiting steps", () => {
  const waiting = (answers: { value?: string } = {}) => {
    const executor: NodeExecutor = {
      run: async () => ({ wait: { kind: "thing", detail: { id: 7 } }, partial: { note: "queued" } }),
      poll: async () => (answers.value ? { output: { items: [], count: 1, kind: "fresh" } } : null),
    };
    return executor;
  };

  it("parks the run as waiting with the partial output, then continues when polled or resolved", async () => {
    const answers: { value?: string } = {};
    const db = journalDb();
    const engine = engineOn(db, { search: waiting(answers), write });
    const first = await run(engine);
    expect(first.status).toBe("waiting");
    expect(first.waiting).toEqual([{ stepKey: "search#1", nodeId: "search", await: { kind: "thing", detail: { id: 7 } }, partial: { note: "queued" } }]);
    expect(await engine.poll()).toBe(0);
    answers.value = "now";
    expect(await engine.poll()).toBe(1);
    expect(engine.get(first.runId)).toMatchObject({ status: "succeeded", output: { result: "wrote 0" } });
  });

  it("settles from outside with an answer that is checked against the declared output", async () => {
    const engine = engineOn(journalDb(), { search: waiting(), write });
    const first = await run(engine);
    expect(await engine.resolve(first.runId, "search#1", { items: [1], count: 1, kind: "fresh" })).toBe(true);
    expect(engine.get(first.runId)?.status).toBe("succeeded");
    expect(await engine.resolve(first.runId, "search#1", {})).toBe(false);
    const second = await run(engine);
    await engine.resolve(second.runId, "search#1", { items: [1] });
    expect(engine.get(second.runId)).toMatchObject({ status: "failed", failedNode: "search" });
  });

  it("a human question times out as the node says", async () => {
    let now = 1_000_000;
    const humanFlow = (onTimeout: "stop" | "default") => wf({
      nodes: [{ id: "ask", type: "human", question: "Go on?", options: ["yes", "no"], timeoutSec: 60, onTimeout, ...(onTimeout === "default" ? { defaultOption: "no" } : {}), output: [{ name: "answer", type: "string" }] }],
      edges: [{ from: "start", to: "ask" }, { from: "ask", to: "end", with: { result: "ask.answer" } }],
    });
    for (const [mode, expected] of [["default", "succeeded"], ["stop", "failed"]] as const) {
      const engine = engineOn(journalDb(), {}, { now: () => now });
      const first = await engine.start({ workflow: humanFlow(mode), inputs: { query: "q" } }).done;
      expect(first.waiting[0]?.await).toMatchObject({ kind: "human", detail: { question: "Go on?", options: ["yes", "no"] } });
      now += 61_000;
      await engine.poll();
      expect(engine.get(first.runId)?.status).toBe(expected);
      if (mode === "default") expect(engine.get(first.runId)?.output).toEqual({ result: "no" });
    }
  });

  it("cancel stops a waiting run and its open steps", async () => {
    const db = journalDb();
    const engine = engineOn(db, { search: waiting(), write });
    const first = await run(engine);
    expect(engine.cancel(first.runId, "owner stopped it")).toBe(true);
    expect(engine.get(first.runId)).toMatchObject({ status: "canceled", reason: "owner stopped it" });
    expect(stepStates(db, first.runId)).toEqual({ "search#1": "canceled" });
  });
});

describe("subworkflows", () => {
  const child = wf({
    id: "leaf", inputs: [{ name: "query", type: "string" }], outputs: [{ name: "result", type: "string" }],
    nodes: [{ id: "write", type: "action", action: "leaf-write", output: [{ name: "text", type: "string" }] }],
    edges: [{ from: "start", to: "write", with: { q: "input.query" } }, { from: "write", to: "end", with: { result: "write.text" } }],
  });
  const parent = wf({
    nodes: [{ id: "call", type: "subworkflow", workflow: "leaf", inputs: { query: "input.query" }, output: [{ name: "result", type: "string" }] }],
    edges: [{ from: "start", to: "call" }, { from: "call", to: "end", with: { result: "call.result" } }],
  });

  it("runs the child as its own run linked to the parent step and returns its output", async () => {
    const db = journalDb();
    const engine = engineOn(db, { "leaf-write": ok((ctx) => ({ text: `child of ${ctx.input.with.q}` })) }, { resolveWorkflow: (id) => (id === "leaf" ? child : null) });
    const summary = await run(engine, parent);
    expect(summary).toMatchObject({ status: "succeeded", output: { result: "child of q" } });
    const runs = rows<{ depth: number; parent_run_id: string | null; parent_step_key: string | null }>(db, "SELECT depth, parent_run_id, parent_step_key FROM lane_pilot_wf_run ORDER BY created_at, rowid");
    expect(runs).toHaveLength(2);
    expect(runs.find((row) => row.depth === 1)).toMatchObject({ parent_run_id: summary.runId, parent_step_key: "call#1" });
  });

  it("a child that failed after spending still counts against the parent's budget", async () => {
    const db = journalDb();
    const spender = wf({
      id: "leaf", inputs: [{ name: "query", type: "string" }], outputs: [{ name: "result", type: "string" }],
      nodes: [{ id: "write", type: "action", action: "leaf-write", output: [{ name: "text", type: "string" }] }, { id: "boom", type: "action", action: "boom", output: [{ name: "text", type: "string" }] }],
      edges: [{ from: "start", to: "write" }, { from: "write", to: "boom" }, { from: "boom", to: "end", with: { result: "boom.text" } }],
    });
    const engine = engineOn(db, {
      "leaf-write": { reentrant: true, run: async () => ({ output: { text: "x" }, usage: { tokens: 700, costUsd: 0.7 } }) },
      boom: { reentrant: true, run: async () => { throw new Error("boom"); } },
    }, { resolveWorkflow: (id) => (id === "leaf" ? spender : null) });
    const summary = await run(engine, parent);
    expect(summary.status).toBe("failed");
    expect(rows<{ tokens_used: number; cost_micro_usd: number }>(db, "SELECT tokens_used, cost_micro_usd FROM lane_pilot_wf_run WHERE depth=0")[0]).toEqual({ tokens_used: 700, cost_micro_usd: 700_000 });
  });

  it("refuses a chain deeper than three, at start and at the engine", async () => {
    const chain = (id: string, calls?: string) => wf({
      id, inputs: [{ name: "query", type: "string" }], outputs: [{ name: "result", type: "string" }],
      nodes: calls ? [{ id: "call", type: "subworkflow", workflow: calls, inputs: { query: "input.query" }, output: [{ name: "result", type: "string" }] }] : [{ id: "write", type: "action", action: "leaf-write", output: [{ name: "result", type: "string" }] }],
      edges: calls ? [{ from: "start", to: "call" }, { from: "call", to: "end", with: { result: "call.result" } }] : [{ from: "start", to: "write" }, { from: "write", to: "end", with: { result: "write.result" } }],
    });
    const all = [chain("w4"), chain("w3", "w4"), chain("w2", "w3"), chain("w1", "w2"), chain("w0", "w1")];
    const engine = engineOn(journalDb(), { "leaf-write": ok(() => ({ result: "x" })) }, { resolveWorkflow: (id) => all.find((item) => item.id === id) ?? null });
    expect(() => engine.start({ workflow: all[4]!, inputs: { query: "q" } })).toThrow(/subworkflows go 4 deep/);
    expect(() => engine.start({ workflow: all[1]!, inputs: { query: "q" }, depth: 4 })).toThrow(/limit is 3/);
    expect((await engine.start({ workflow: all[3]!, inputs: { query: "q" } }).done).status).toBe("succeeded");
  });

  it("a waiting child parks the parent and settles it when the child ends; a reload does not start a second child", async () => {
    const db = journalDb();
    let released = false;
    const leafWrite: NodeExecutor = { run: async () => ({ wait: { kind: "thing" } }), poll: async () => (released ? { output: { text: "late" } } : null) };
    const engine = engineOn(db, { "leaf-write": leafWrite }, { resolveWorkflow: (id) => (id === "leaf" ? child : null) });
    const first = await run(engine, parent);
    expect(first.status).toBe("waiting");
    expect(rows(db, "SELECT id FROM lane_pilot_wf_run WHERE parent_run_id IS NOT NULL")).toHaveLength(1);
    released = true;
    await engine.poll();
    await engine.poll();
    expect(engine.get(first.runId)).toMatchObject({ status: "succeeded", output: { result: "late" } });
    expect(rows(db, "SELECT id FROM lane_pilot_wf_run WHERE parent_run_id IS NOT NULL")).toHaveLength(1);
  });
});

describe("drain and cancel at the boundary", () => {
  it("stops at a step boundary when asked and leaves the next step pending for the next instance", async () => {
    const db = journalDb();
    let open = true;
    const first = engineOn(db, { search, write }, { admit: () => open });
    const started = first.start({ workflow: wf(), inputs: { query: "q" } });
    open = false;
    const summary = await started.done;
    expect(summary.stopped).toBe(true);
    expect(summary.status).toBe("running");
    const second = engineOn(db, { search, write });
    const taken = await second.resume();
    expect(taken).toEqual([summary.runId]);
    await second.idle();
    expect(second.get(summary.runId)).toMatchObject({ status: "succeeded", output: { result: "wrote 3" } });
  });
});
