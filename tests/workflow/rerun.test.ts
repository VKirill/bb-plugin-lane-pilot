import { describe, expect, it } from "vitest";
import type { StepContext } from "../../src/workflow/engine";
import { engineOn, journalDb, ok, rows, stepStates, wf } from "./engine-helpers";

/** W7: the owner re-runs one node of a finished run; what came out of it is removed and the run goes on from there. */
describe("re-running one node of a finished run", () => {
  it("re-runs a failed node with the same inputs, keeps the steps before it, and finishes the run", async () => {
    const db = journalDb();
    let fail = true;
    const seen: string[] = [];
    const engine = engineOn(db, {
      search: ok(() => { seen.push("search"); return { items: ["a"], count: 1, kind: "fresh" }; }),
      write: ok(() => { if (fail) throw new Error("telegram down"); return { text: "written" }; }),
    });
    const { runId, done } = engine.start({ workflow: wf(), inputs: { query: "q" } });
    expect(await done).toMatchObject({ status: "failed", failedNode: "write" });
    fail = false;
    const result = await engine.rerunNode(runId, "write");
    expect(result).toMatchObject({ ok: true, stepKey: "write#1" });
    await engine.idle();
    expect(engine.get(runId)).toMatchObject({ status: "succeeded", output: { result: "written" }, reason: null });
    expect(seen).toEqual(["search"]);
    expect(stepStates(db, runId)).toEqual({ "search#1": "succeeded", "write#1": "succeeded" });
    expect(rows(db, "SELECT kind FROM lane_pilot_wf_event WHERE run_id=? AND kind='rerun'", runId)).toHaveLength(1);
  });

  it("re-running an earlier node removes everything after it and gives the step a new spawn key", async () => {
    const db = journalDb();
    const keys: string[] = [];
    const writes: string[] = [];
    const engine = engineOn(db, {
      search: ok((ctx: StepContext) => { keys.push(ctx.spawnKey); return { items: ["a"], count: 1, kind: "fresh" }; }),
      write: ok(() => { writes.push("w"); return { text: `written ${writes.length}` }; }),
    });
    const { runId, done } = engine.start({ workflow: wf(), inputs: { query: "q" } });
    expect(await done).toMatchObject({ status: "succeeded", output: { result: "written 1" } });
    // An effect recorded by a later node is forgotten with it, so the re-run does the outside call again.
    db.prepare("INSERT INTO lane_pilot_wf_effect(id,run_id,step_key,effect_key,kind,state,created_at,updated_at) VALUES ('e1',?,?,'send','x','done',1,1)").run(runId, "write#1");
    expect(await engine.rerunNode(runId, "search")).toMatchObject({ ok: true, removed: 1 });
    await engine.idle();
    expect(engine.get(runId)).toMatchObject({ status: "succeeded", output: { result: "written 2" } });
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(rows(db, "SELECT 1 FROM lane_pilot_wf_effect WHERE run_id=?", runId)).toHaveLength(0);
    expect(rows(db, "SELECT steps_used FROM lane_pilot_wf_run WHERE id=?", runId)).toEqual([{ steps_used: 2 }]);
  });

  it("refuses a run that is active, a node that never ran, an unknown node and a run that does not exist", async () => {
    const db = journalDb();
    let release: () => void = () => undefined;
    const engine = engineOn(db, {
      search: { reentrant: true, run: () => new Promise((resolve) => { release = () => resolve({ output: { items: [], count: 0, kind: "fresh" } }); }) },
      write: ok(() => ({ text: "w" })),
    });
    const { runId, done } = engine.start({ workflow: wf(), inputs: { query: "q" } });
    expect(await engine.rerunNode(runId, "search")).toEqual({ ok: false, reason: "run_active" });
    release();
    await done;
    expect(await engine.rerunNode(runId, "nope")).toEqual({ ok: false, reason: "unknown_node" });
    expect(await engine.rerunNode("wfrun_missing", "search")).toEqual({ ok: false, reason: "not_found" });
    const failing = engineOn(journalDb(), { search: ok(() => { throw new Error("x"); }), write: ok(() => ({ text: "w" })) });
    const second = failing.start({ workflow: wf(), inputs: { query: "q" } });
    await second.done;
    expect(await failing.rerunNode(second.runId, "write")).toEqual({ ok: false, reason: "node_not_run" });
  });

  it("re-running one branch of a fan-out revives the join and the steps after it", async () => {
    const db = journalDb();
    let broken = true;
    const flow = wf({
      inputs: [{ name: "items", type: "array" }],
      outputs: [{ name: "summary", type: "json" }],
      nodes: [
        { id: "fan", type: "parallel", for_each: "$inputs.items", child: { type: "action", action: "work", output: [{ name: "label", type: "string" }] },
          join: { policy: "all", uses: "reduce", out: [{ name: "labels", type: "array" }] } },
        { id: "done", type: "action", action: "emit", map: { summary: "fan.labels" } },
      ],
      edges: [{ from: "start", to: "fan" }, { from: "fan", to: "done" }],
    });
    const engine = engineOn(db, {
      reduce: ok((ctx) => ({ labels: (ctx.input.with.results as Array<{ label: string }>).map((row) => row.label) })),
      work: ok((ctx) => { const id = String((ctx.input.item as { id: string }).id); if (broken && id === "b") throw new Error("boom"); return { label: id }; }),
    });
    const { runId, done } = engine.start({ workflow: flow, inputs: { items: [{ id: "a" }, { id: "b" }] } });
    expect(await done).toMatchObject({ status: "failed" });
    broken = false;
    const failedChild = rows<{ node_id: string }>(db, "SELECT node_id FROM lane_pilot_wf_step WHERE run_id=? AND state='failed'", runId)[0]!.node_id;
    expect(await engine.rerunNode(runId, failedChild)).toMatchObject({ ok: true });
    await engine.idle();
    expect(engine.get(runId)).toMatchObject({ status: "succeeded", output: { summary: ["a", "b"] } });
  });

  // Audit 2026-10-08 r2, B1: a failed run fires its abort controller; a re-run used to reuse the fired one.
  it("a cancel after the re-run of a failed run still aborts the re-run's step", async () => {
    const db = journalDb();
    let fail = true;
    const signals: AbortSignal[] = [];
    const engine = engineOn(db, {
      search: ok(() => ({ items: ["a"], count: 1, kind: "fresh" })),
      write: { reentrant: true, run: (ctx: StepContext) => { if (fail) throw new Error("down"); signals.push(ctx.signal); return new Promise(() => undefined); } },
    });
    const { runId, done } = engine.start({ workflow: wf(), inputs: { query: "q" } });
    expect(await done).toMatchObject({ status: "failed" });
    fail = false;
    expect(await engine.rerunNode(runId, "write")).toMatchObject({ ok: true });
    for (let tick = 0; tick < 50 && !signals.length; tick++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    expect(engine.cancel(runId)).toBe(true);
    expect(signals[0]!.aborted).toBe(true);
  });

  it("the goal audit of a re-run gets a live signal", async () => {
    const db = journalDb();
    let fail = true;
    const audited: boolean[] = [];
    const engine = engineOn(db, {
      search: ok(() => ({ items: ["a"], count: 1, kind: "fresh" })),
      write: ok(() => { if (fail) throw new Error("down"); return { text: "written" }; }),
    }, { auditGoals: async (input) => { audited.push(input.signal.aborted); return { met: input.goals.map((goal) => goal.id), unmet: [] }; } });
    const goals = [{ id: "g1", done_when: "it is written", evidence: "text in the output" }];
    const { runId, done } = engine.start({ workflow: wf(), inputs: { query: "q" }, goals });
    expect(await done).toMatchObject({ status: "failed" });
    fail = false;
    expect(await engine.rerunNode(runId, "write")).toMatchObject({ ok: true });
    await engine.idle();
    expect(engine.get(runId)).toMatchObject({ status: "succeeded" });
    expect(audited).toEqual([false]);
  });
});
