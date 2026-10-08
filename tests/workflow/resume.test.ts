import { describe, expect, it } from "vitest";
import type { NodeExecutor } from "../../src/workflow/engine";
import { CrashError, engineOn, journalDb, ok, rows, stepStates, wf } from "./engine-helpers";

const until = async (what: string, read: () => unknown, ms = 3000) => {
  const end = Date.now() + ms;
  while (!read()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((resolve) => setTimeout(resolve, 5)); }
};
const search = ok(() => ({ items: ["a"], count: 1, kind: "fresh" }));
const write = ok(() => ({ text: "written" }));

describe("a reload in the middle of a node", () => {
  it("re-runs a reentrant step with the same spawn key and finishes the run from the journal", async () => {
    const db = journalDb();
    const keys: string[] = [];
    const hang: NodeExecutor = { reentrant: true, run: (ctx) => { keys.push(ctx.spawnKey); return new Promise(() => undefined); } };
    const first = engineOn(db, { search: hang, write });
    const { runId } = first.start({ workflow: wf(), inputs: { query: "q" } });
    await until("search running", () => stepStates(db, runId)["search#1"] === "running");
    first.dispose();

    const second = engineOn(db, { search: ok((ctx) => { keys.push(ctx.spawnKey); return { items: ["a"], count: 1, kind: "fresh" }; }), write });
    expect(await second.resume()).toEqual([runId]);
    await second.idle();
    expect(second.get(runId)).toMatchObject({ status: "succeeded", output: { result: "written" } });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(Object.keys(stepStates(db, runId))).toEqual(["search#1", "write#1"]);
    const log = rows<{ from_state: string; to_state: string }>(db, "SELECT from_state, to_state FROM lane_pilot_wf_event WHERE run_id=? AND step_key='search#1' AND kind='step'", runId).map((event) => `${event.from_state}>${event.to_state}`);
    expect(log).toEqual(["null>pending", "pending>running", "running>pending", "pending>running", "running>succeeded"]);
  });

  it("interrupts a step that is not reentrant, and the run with it, instead of running it twice", async () => {
    const db = journalDb();
    let runs = 0;
    const hang: NodeExecutor = { run: () => { runs += 1; return new Promise(() => undefined); } };
    const first = engineOn(db, { search: hang, write });
    const { runId } = first.start({ workflow: wf(), inputs: { query: "q" } });
    await until("search running", () => stepStates(db, runId)["search#1"] === "running");
    first.dispose();
    const second = engineOn(db, { search: hang, write });
    await second.resume();
    await second.idle();
    expect(runs).toBe(1);
    expect(second.get(runId)).toMatchObject({ status: "interrupted", reason: "step_interrupted:search:not_reentrant" });
    expect(stepStates(db, runId)["search#1"]).toBe("interrupted");
  });

  it("does not re-run a step that began under another build", async () => {
    const db = journalDb();
    const hang: NodeExecutor = { reentrant: true, run: () => new Promise(() => undefined) };
    const first = engineOn(db, { search: hang, write }, { harnessVersion: "1.0.0" });
    const { runId } = first.start({ workflow: wf(), inputs: { query: "q" } });
    await until("search running", () => stepStates(db, runId)["search#1"] === "running");
    first.dispose();
    const second = engineOn(db, { search, write }, { harnessVersion: "2.0.0" });
    await second.resume();
    await second.idle();
    expect(second.get(runId)).toMatchObject({ status: "interrupted", reason: "step_interrupted:search:harness_changed" });
  });

  it("a deploy (the plugin version string changes) does not stop a run: the engine compatibility version decides, not the build", async () => {
    const db = journalDb();
    const hang: NodeExecutor = { reentrant: true, run: () => new Promise(() => undefined) };
    const first = engineOn(db, { search: hang, write }, { harnessVersion: "0.1.192", compatVersion: "wfe-1" });
    const { runId } = first.start({ workflow: wf(), inputs: { query: "q" } });
    await until("search running", () => stepStates(db, runId)["search#1"] === "running");
    first.dispose();
    const second = engineOn(db, { search, write }, { harnessVersion: "0.1.193", compatVersion: "wfe-1" });
    expect(await second.resume()).toEqual([runId]);
    await second.idle();
    expect(second.get(runId)).toMatchObject({ status: "succeeded", output: { result: "written" } });
  });

  it("a step stamped with a plugin version (before compat versions) resumes under a compat version; a different compat version is refused with a reason", async () => {
    const hang: NodeExecutor = { reentrant: true, run: () => new Promise(() => undefined) };
    const legacy = journalDb();
    const old = engineOn(legacy, { search: hang, write }, { harnessVersion: "0.1.192" }); // before compat versions: the build is stamped
    const started = old.start({ workflow: wf(), inputs: { query: "q" } });
    await until("search running", () => stepStates(legacy, started.runId)["search#1"] === "running");
    old.dispose();
    const upgraded = engineOn(legacy, { search, write }, { harnessVersion: "0.1.193", compatVersion: "wfe-1" });
    await upgraded.resume();
    await upgraded.idle();
    expect(upgraded.get(started.runId)?.status).toBe("succeeded");
    // Two compat versions that differ: the step began under wfe-1, the engine is wfe-2.
    const db = journalDb();
    const first = engineOn(db, { search: hang, write }, { harnessVersion: "0.1.192", compatVersion: "wfe-1" });
    const { runId } = first.start({ workflow: wf(), inputs: { query: "q" } });
    await until("search running", () => stepStates(db, runId)["search#1"] === "running");
    first.dispose();
    const second = engineOn(db, { search, write }, { harnessVersion: "0.1.193", compatVersion: "wfe-2" });
    await second.resume();
    await second.idle();
    expect(second.get(runId)).toMatchObject({ status: "interrupted", reason: "step_interrupted:search:harness_changed" });
    expect(rows<{ error: string }>(db, "SELECT error FROM lane_pilot_wf_step WHERE run_id=? AND step_key='search#1'", runId)[0]!.error).toContain("began under engine wfe-1, this one is wfe-2");
  });

  it("goes on with pending steps under a new build", async () => {
    const db = journalDb();
    let open = true;
    const first = engineOn(db, { search, write }, { harnessVersion: "1.0.0", admit: () => { const was = open; open = false; return was; } });
    const { runId, done } = first.start({ workflow: wf(), inputs: { query: "q" } });
    await done;
    expect(stepStates(db, runId)).toEqual({ "search#1": "succeeded", "write#1": "pending" });
    const second = engineOn(db, { search, write }, { harnessVersion: "2.0.0" });
    await second.resume();
    await second.idle();
    expect(second.get(runId)?.status).toBe("succeeded");
  });
});

describe("two instances during a reload", () => {
  it("leaves a run to the instance that holds its lease and takes it over when the lease ran out or was released", async () => {
    const db = journalDb();
    let now = 5_000_000;
    const hang: NodeExecutor = { reentrant: true, run: () => new Promise(() => undefined) };
    const old = engineOn(db, { search: hang, write }, { now: () => now, leaseMs: 60_000 });
    const { runId } = old.start({ workflow: wf(), inputs: { query: "q" } });
    await until("search running", () => stepStates(db, runId)["search#1"] === "running");

    const fresh = engineOn(db, { search, write }, { now: () => now, leaseMs: 60_000 });
    expect(await fresh.resume()).toEqual([]);
    expect(stepStates(db, runId)["search#1"]).toBe("running");
    now += 61_000;
    expect(await fresh.resume()).toEqual([runId]);
    await fresh.idle();
    expect(fresh.get(runId)?.status).toBe("succeeded");
    old.dispose();
  });

  it("a disposed instance gives its leases back", async () => {
    const db = journalDb();
    const hang: NodeExecutor = { reentrant: true, run: () => new Promise(() => undefined) };
    const old = engineOn(db, { search: hang, write });
    const { runId } = old.start({ workflow: wf(), inputs: { query: "q" } });
    await until("search running", () => stepStates(db, runId)["search#1"] === "running");
    expect(rows<{ owner_id: string | null }>(db, "SELECT owner_id FROM lane_pilot_wf_run")[0]!.owner_id).toBe(old.instanceId);
    old.dispose();
    expect(rows<{ owner_id: string | null }>(db, "SELECT owner_id FROM lane_pilot_wf_run")[0]!.owner_id).toBeNull();
  });
});

describe("effects", () => {
  const flow = wf({ nodes: [{ id: "search", type: "action", action: "search", output: [{ name: "items", type: "array" }, { name: "count", type: "number" }, { name: "kind", type: "enum", values: ["fresh", "stale"] }] }, { id: "write", type: "action", action: "write", output: [{ name: "text", type: "string" }] }] });

  it("records an external call as intended and then done, and does not repeat a done one", async () => {
    const db = journalDb();
    let calls = 0;
    const post = (ctx: Parameters<NodeExecutor["run"]>[0]) => ctx.effect("post", "http", async () => { calls += 1; return `posted ${calls}`; });
    const engine = engineOn(db, { search, write: ok(async (ctx) => ({ text: `${await post(ctx)} / ${await post(ctx)}` })) });
    const summary = await engine.start({ workflow: flow, inputs: { query: "q" } }).done;
    expect(summary.output).toEqual({ result: "posted 1 / posted 1" });
    expect(calls).toBe(1);
    expect(rows<{ state: string; result_json: string }>(db, "SELECT state, result_json FROM lane_pilot_wf_effect")).toEqual([{ state: "done", result_json: "\"posted 1\"" }]);
  });

  it("after a crash between the call and its record, asks the world instead of calling again", async () => {
    const world = new Set<string>();
    let calls = 0;
    const effectful = (id: string): NodeExecutor => ({
      reentrant: true,
      run: async (ctx) => ({ output: { text: await ctx.effect("post", "http", async () => { calls += 1; world.add(id); return "posted"; }, {
        reconcile: async () => (world.has(id) ? { happened: true as const, result: "posted" } : { happened: false as const }),
      }) } }),
    });
    for (const crashAt of ["effect-intended", "effect-called"]) {
      world.clear(); calls = 0;
      const db = journalDb();
      let dead = false;
      const first = engineOn(db, { search, write: effectful("w") }, { fault: (point) => { if (dead || point === crashAt) { dead = true; throw new CrashError("died"); } } });
      await expect(first.start({ workflow: flow, inputs: { query: "q" } }).done).rejects.toBeInstanceOf(CrashError);
      const second = engineOn(db, { search, write: effectful("w") });
      await second.resume({ takeOver: true });
      await second.idle();
      const runId = rows<{ id: string }>(db, "SELECT id FROM lane_pilot_wf_run")[0]!.id;
      expect(second.get(runId)).toMatchObject({ status: "succeeded", output: { result: "posted" } });
      expect(calls).toBe(1);
    }
  });

  it("with no way to ask the world, an effect left intended fails the step instead of being repeated", async () => {
    const db = journalDb();
    let calls = 0;
    const executor: NodeExecutor = { reentrant: true, run: async (ctx) => ({ output: { text: await ctx.effect("post", "http", async () => { calls += 1; return "posted"; }) } }) };
    let dead = false;
    const first = engineOn(db, { search, write: executor }, { fault: (point) => { if (dead || point === "effect-called") { dead = true; throw new CrashError("died"); } } });
    await expect(first.start({ workflow: flow, inputs: { query: "q" } }).done).rejects.toBeInstanceOf(CrashError);
    const second = engineOn(db, { search, write: executor });
    await second.resume({ takeOver: true });
    await second.idle();
    const runId = rows<{ id: string }>(db, "SELECT id FROM lane_pilot_wf_run")[0]!.id;
    expect(second.get(runId)).toMatchObject({ status: "failed", error: "effect_unknown:post" });
    expect(calls).toBe(1);
    expect(rows<{ state: string }>(db, "SELECT state FROM lane_pilot_wf_effect")[0]!.state).toBe("unknown");
  });
});

describe("a crash at every point of the journal", () => {
  const items = [1, 2, 3];
  const flow = wf({
    outputs: [{ name: "total", type: "number" }],
    nodes: [
      { id: "search", type: "action", action: "search", output: [{ name: "items", type: "array" }, { name: "count", type: "number" }] },
      { id: "route", type: "decision", reads: "search", output: [{ name: "count", type: "number" }] },
      { id: "split", type: "parallel", foreach: "search.items" },
      { id: "rate", type: "action", action: "rate", output: [{ name: "score", type: "number" }] },
      { id: "gather", type: "join", parallel: "split", output: [{ name: "results", type: "array" }] },
      { id: "sum", type: "action", action: "sum", output: [{ name: "total", type: "number" }] },
      { id: "small", type: "action", action: "small", output: [{ name: "total", type: "number" }] },
    ],
    edges: [
      { from: "start", to: "search" }, { from: "search", to: "route" },
      { from: "route", to: "small", when: { field: "count", op: "lt", value: 1 } },
      { from: "route", to: "split" },
      { from: "split", to: "rate" }, { from: "rate", to: "gather", with: { score: "rate.score" } },
      { from: "gather", to: "sum", with: { results: "gather.results" } },
      { from: "sum", to: "end", with: { total: "sum.total" } },
      { from: "small", to: "end", with: { total: "small.total" } },
    ],
  });

  function world() {
    const external = new Map<number, number>();
    const executors = {
      search: ok(() => ({ items, count: items.length })),
      small: ok(() => ({ total: 0 })),
      rate: ok(async (ctx) => {
        const item = ctx.input.item as number;
        const score = await ctx.effect(`rate-${item}`, "write", async () => { external.set(item, (external.get(item) ?? 0) + 1); return item * 10; }, {
          reconcile: async () => (external.has(item) ? { happened: true as const, result: item * 10 } : { happened: false as const }),
        });
        return { score };
      }),
      sum: ok((ctx) => ({ total: (ctx.input.with.results as Array<{ score: number }>).reduce((sum, row) => sum + row.score, 0) })),
    };
    return { external, executors };
  }

  it("finishes with the same result whichever point the process dies at, and calls the outside world once per item", async () => {
    let points = 0;
    const reference = world();
    const refDb = journalDb();
    const clean = await engineOn(refDb, reference.executors, { fault: () => { points += 1; } }).start({ workflow: flow, inputs: { query: "q" } }).done;
    expect(clean).toMatchObject({ status: "succeeded", output: { total: 60 } });
    const referenceSteps = Object.keys(stepStates(refDb, clean.runId)).sort();
    expect(points).toBeGreaterThan(30);

    let unfinished = 0;
    for (let crashAt = 1; crashAt <= points; crashAt += 1) {
      const db = journalDb();
      const mine = world();
      let seen = 0, dead = false;
      const first = engineOn(db, mine.executors, { fault: () => { seen += 1; if (dead || seen === crashAt) { dead = true; throw new CrashError(`died at ${crashAt}`); } } });
      const attempt = first.start({ workflow: flow, inputs: { query: "q" } }).done;
      await attempt.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(dead, `crash at ${crashAt} fired`).toBe(true);
      if (rows<{ status: string }>(db, "SELECT status FROM lane_pilot_wf_run")[0]?.status === "running") unfinished += 1;
      const second = engineOn(db, mine.executors);
      await second.resume({ takeOver: true });
      await second.idle();
      const runs = rows<{ id: string; status: string; output_json: string | null }>(db, "SELECT id, status, output_json FROM lane_pilot_wf_run");
      expect(runs, `crash at ${crashAt}`).toHaveLength(1);
      expect(runs[0]!.status, `crash at ${crashAt}`).toBe("succeeded");
      expect(JSON.parse(runs[0]!.output_json!), `crash at ${crashAt}`).toEqual({ total: 60 });
      expect(Object.keys(stepStates(db, runs[0]!.id)).sort(), `crash at ${crashAt}`).toEqual(referenceSteps);
      expect([...mine.external.values()], `crash at ${crashAt}`).toEqual([1, 1, 1]);
    }
    expect(unfinished).toBeGreaterThan(points / 2);
  }, 60_000);
});
