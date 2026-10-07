import { describe, expect, it } from "vitest";
import type { NodeExecutor, StepContext } from "../../src/workflow/engine";
import { engineOn, journalDb, ok, rows, stepStates, wf } from "./engine-helpers";

/**
 * The features of the chains spec that were refused before W3: join policies other than `all`, votes above 1, order
 * `depends_on` and `on_child_fail`. Each is run through the real engine on stubs.
 */
type Row = Record<string, unknown>;

const fan = (parallel: Record<string, unknown>, join: Record<string, unknown> = {}, child?: Record<string, unknown>) => wf({
  inputs: [{ name: "items", type: "array" }],
  outputs: [{ name: "summary", type: "json" }],
  nodes: [
    { id: "fan", type: "parallel", for_each: "$inputs.items", ...parallel,
      child: child ?? { type: "action", action: "work", output: [{ name: "ok", type: "boolean" }, { name: "label", type: "string" }] },
      join: { policy: "all", uses: "reduce", out: [{ name: "labels", type: "array" }, { name: "failed", type: "array" }, { name: "text", type: "string" }], ...join } },
    { id: "done", type: "action", action: "emit", map: { summary: "fan.labels" } },
  ],
  edges: [{ from: "start", to: "fan" }, { from: "fan", to: "done" }],
});

/** The reducer sees `results` (finished branches), `failed` (tolerated ones with their item and error) and every `rows`. */
const reduce = ok((ctx) => {
  const results = ctx.input.with.results as Row[], failed = ctx.input.with.failed as Array<{ item: Row; error: string; blocked: boolean }>;
  return { labels: results.map((row) => row.label), failed: failed.map((row) => `${(row.item as Row | null)?.id ?? row.item}:${row.error}`), text: String(failed.length) };
});
const run = (workflow: ReturnType<typeof fan>, executors: Record<string, NodeExecutor>, items: unknown[], db = journalDb()) => {
  const engine = engineOn(db, { reduce, ...executors });
  return { db, engine, started: engine.start({ workflow, inputs: { items } }) };
};
const output = (summary: { output: Record<string, unknown> | null }) => summary.output;

describe("join policy", () => {
  const flaky = (bad: string[]) => ({ work: ok((ctx: StepContext) => { const item = ctx.input.item as Row; if (bad.includes(String(item.id))) throw new Error(`boom ${item.id}`); return { ok: true, label: String(item.id) }; }) });
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("`all` fails the run on the first failed branch, as before", async () => {
    const { started } = run(fan({}), flaky(["b"]), items);
    expect(await started.done).toMatchObject({ status: "failed", error: "boom b" });
  });

  it("`majority` lets a minority fail and tells the reducer which branches and why", async () => {
    const { db, started } = run(fan({}, { policy: "majority" }), flaky(["b"]), items);
    const summary = await started.done;
    expect(summary).toMatchObject({ status: "succeeded" });
    expect(output(summary)).toEqual({ summary: ["a", "c"] });
    const join = rows<{ input_json: string }>(db, "SELECT input_json FROM lane_pilot_wf_step WHERE run_id=? AND node_id='fan'", summary.runId)[0]!;
    expect(JSON.parse(join.input_json).with.failed).toEqual([{ branch: 1, item: { id: "b" }, error: "boom b", blocked: false }]);
    expect(JSON.parse(join.input_json).with.items).toEqual(items);
  });

  it("`majority` fails the run when no more than half of the branches succeeded", async () => {
    const { started } = run(fan({}, { policy: "majority" }), flaky(["a", "b"]), items);
    const summary = await started.done;
    expect(summary).toMatchObject({ status: "failed" });
    expect(summary.error).toContain("join_no_majority: 1 of 3");
    expect(summary.failedNode).toBe("fan");
  });

  it("`all_or_low_confidence` goes on with whatever finished, even with nothing", async () => {
    const some = run(fan({}, { policy: "all_or_low_confidence" }), flaky(["c"]), items);
    expect(output(await some.started.done)).toEqual({ summary: ["a", "b"] });
    const none = run(fan({}, { policy: "all_or_low_confidence" }), flaky(["a", "b", "c"]), items);
    const summary = await none.started.done;
    expect(summary.status).toBe("succeeded");
    expect(output(summary)).toEqual({ summary: [] });
  });

  it("a waiting branch that ends with an error arrives failed; the others are settled from outside", async () => {
    let polled = 0;
    const wait: NodeExecutor = { run: async () => ({ wait: { kind: "external" } }), poll: async () => { polled += 1; return polled === 1 ? { error: "gone" } : null; } };
    const { db, engine, started } = run(fan({}, { policy: "majority" }), { work: wait }, items);
    const first = await started.done;
    expect(first.status).toBe("waiting");
    expect(first.waiting).toHaveLength(3);
    await engine.poll();
    const rest = engine.get(first.runId)!.waiting;
    expect(rest).toHaveLength(2);
    await engine.resolve(first.runId, rest[0]!.stepKey, { ok: true, label: "b" });
    await engine.resolve(first.runId, rest[1]!.stepKey, { ok: true, label: "c" });
    expect(rows(db, "SELECT 1 FROM lane_pilot_wf_arrival WHERE run_id=?", first.runId)).toHaveLength(3);
    expect(engine.get(first.runId)).toMatchObject({ status: "succeeded", output: { summary: ["b", "c"] } });
  });
});

describe("votes", () => {
  const tally = (answers: Record<string, boolean[]>) => {
    const calls: Record<string, number> = {};
    const work = ok((ctx: StepContext) => {
      const id = String((ctx.input.item as Row).id);
      const at = calls[id] = (calls[id] ?? -1) + 1;
      return { ok: answers[id]![at]!, label: id, handoff: "voted" };
    });
    return { work, calls };
  };
  const voted = { type: "agent", role: "code-critic", uses: "work", votes: 3, output: [{ name: "ok", type: "boolean" }, { name: "label", type: "string" }] };

  it("runs the node `votes` times independently and decides each boolean by more than half", async () => {
    const { work, calls } = tally({ a: [true, true, false], b: [false, true, false] });
    const spawnKeys: string[] = [];
    const { db, started } = run(fan({}, {}, voted), { work: { ...work, run: async (ctx: StepContext) => { spawnKeys.push(`${ctx.vote?.index}/${ctx.vote?.of}:${ctx.spawnKey}`); return work.run(ctx); } }, reduce: ok((ctx) => ({ labels: (ctx.input.with.results as Row[]).map((row) => `${row.label}=${row.ok}`), failed: [], text: "" })) }, [{ id: "a" }, { id: "b" }]);
    const summary = await started.done;
    expect(output(summary)).toEqual({ summary: ["a=true", "b=false"] });
    expect(calls).toEqual({ a: 2, b: 2 });
    // Six independent runs, six different spawn keys.
    expect(new Set(spawnKeys.map((key) => key.split(":")[1])).size).toBe(6);
    expect(spawnKeys.filter((key) => key.startsWith("2/3")).length).toBe(2);
    const step = rows<{ receipt_json: string }>(db, "SELECT receipt_json FROM lane_pilot_wf_step WHERE run_id=? AND node_id='fan:child' ORDER BY rowid", summary.runId)[0]!;
    expect(JSON.parse(step.receipt_json).detail.votes).toHaveLength(3);
  });

  it("one vote that fails still leaves a majority; two failures end the step", async () => {
    let call = 0;
    const work = ok(() => { call += 1; if (call % 3 === 1) throw new Error("one down"); return { ok: true, label: "x", handoff: "h" }; });
    const survived = run(fan({}, { policy: "all" }, voted), { work }, [{ id: "a" }]);
    expect(output(await survived.started.done)).toEqual({ summary: ["x"] });
    let n = 0;
    const lost = run(fan({}, { policy: "all" }, voted), { work: ok(() => { n += 1; if (n % 3 !== 0) throw new Error("two down"); return { ok: true, label: "x", handoff: "h" }; }) }, [{ id: "a" }]);
    const summary = await lost.started.done;
    expect(summary.status).toBe("failed");
    expect(summary.error).toContain("votes: 1 of 3 answered");
  });
});

describe("order depends_on and on_child_fail", () => {
  const order: string[] = [];
  const work = (bad: string[] = []) => ok(async (ctx: StepContext) => {
    const item = ctx.input.item as Row;
    order.push(`start:${item.id}`);
    await new Promise((resolve) => setTimeout(resolve, item.id === "slow" ? 25 : 1));
    if (bad.includes(String(item.id))) throw new Error(`boom ${item.id}`);
    order.push(`end:${item.id}`);
    return { ok: true, label: String(item.id) };
  });

  it("starts an item only after the items it depends on have finished; the others run together", async () => {
    order.length = 0;
    const items = [{ id: "c", depends_on: ["b"] }, { id: "slow" }, { id: "b", depends_on: ["a", "slow"] }, { id: "a" }, { id: "free" }];
    const { started } = run(fan({ order: "depends_on" }), { work: work() }, items);
    const summary = await started.done;
    expect(summary.status).toBe("succeeded");
    expect(output(summary)).toEqual({ summary: ["c", "slow", "b", "a", "free"] });
    expect(order.indexOf("start:b")).toBeGreaterThan(order.indexOf("end:slow"));
    expect(order.indexOf("start:b")).toBeGreaterThan(order.indexOf("end:a"));
    expect(order.indexOf("start:c")).toBeGreaterThan(order.indexOf("end:b"));
    // Independent items did not wait for the slow one.
    expect(order.indexOf("end:free")).toBeLessThan(order.indexOf("end:slow"));
  });

  it("an id outside the list counts as done; a cycle fails the run before anything starts", async () => {
    order.length = 0;
    const known = run(fan({ order: "depends_on" }), { work: work() }, [{ id: "a", depends_on: ["earlier-run-task"] }]);
    expect(output(await known.started.done)).toEqual({ summary: ["a"] });
    order.length = 0;
    const cycle = run(fan({ order: "depends_on" }), { work: work() }, [{ id: "a", depends_on: ["b"] }, { id: "b", depends_on: ["a"] }]);
    const summary = await cycle.started.done;
    expect(summary.status).toBe("failed");
    expect(summary.reason).toContain("depends_cycle");
    expect(order).toEqual([]);
  });

  it("on_child_fail block_dependents: a failed item blocks what depends on it, transitively, and the rest goes on", async () => {
    order.length = 0;
    const items = [{ id: "a" }, { id: "b", depends_on: ["a"] }, { id: "c", depends_on: ["b"] }, { id: "d" }];
    const { db, started } = run(fan({ order: "depends_on", on_child_fail: "block_dependents" }), { work: work(["a"]) }, items);
    const summary = await started.done;
    expect(summary.status).toBe("succeeded");
    expect(output(summary)).toEqual({ summary: ["d"] });
    expect(order.filter((entry) => entry.startsWith("start:")).sort()).toEqual(["start:a", "start:d"]);
    const join = rows<{ input_json: string }>(db, "SELECT input_json FROM lane_pilot_wf_step WHERE run_id=? AND node_id='fan'", summary.runId)[0]!;
    expect(JSON.parse(join.input_json).with.failed).toEqual([
      { branch: 0, item: { id: "a" }, error: "boom a", blocked: false },
      { branch: 1, item: { id: "b", depends_on: ["a"] }, error: "upstream_blocked:a", blocked: true },
      { branch: 2, item: { id: "c", depends_on: ["b"] }, error: "upstream_blocked:b", blocked: true },
    ]);
    expect(Object.values(stepStates(db, summary.runId)).filter((state) => state === "canceled")).toHaveLength(2);
  });

  it("without on_child_fail a failed item still fails an `all` join", async () => {
    const { started } = run(fan({ order: "depends_on" }), { work: work(["a"]) }, [{ id: "a" }, { id: "b", depends_on: ["a"] }]);
    expect(await started.done).toMatchObject({ status: "failed", error: "boom a" });
  });
});

describe("a reload while ordered branches wait", () => {
  it("the dependents start after the reload once their dependency has arrived", async () => {
    const db = journalDb();
    let release: (() => void) | null = null;
    const slow: NodeExecutor = { reentrant: true, run: (ctx) => new Promise((resolve) => { release = () => resolve({ output: { ok: true, label: String((ctx.input.item as Row).id) } }); }) };
    const first = engineOn(db, { reduce, work: slow });
    const { runId } = first.start({ workflow: fan({ order: "depends_on" }), inputs: { items: [{ id: "a" }, { id: "b", depends_on: ["a"] }] } });
    for (let tries = 0; tries < 200 && !release; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(release).not.toBeNull();
    // "a" runs, "b" is pending behind it; the instance goes away mid-step.
    expect(Object.entries(stepStates(db, runId)).filter(([key]) => key.startsWith("fan:child")).map(([, state]) => state).sort()).toEqual(["pending", "running"]);
    first.dispose();
    const second = engineOn(db, { reduce, work: ok((ctx) => ({ ok: true, label: String((ctx.input.item as Row).id) })) });
    await second.resume();
    await second.idle();
    expect(second.get(runId)).toMatchObject({ status: "succeeded", output: { summary: ["a", "b"] } });
  });
});
