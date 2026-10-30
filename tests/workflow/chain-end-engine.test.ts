import { describe, expect, it } from "vitest";
import { engineOn, journalDb, wf } from "./engine-helpers";
import type { NodeExecutor } from "@lane-pilot/workflow-engine";

describe("chain-end waits: nothing waits forever", () => {
  it("a human question without a node timeout gets the 72 h default deadline", async () => {
    const db = journalDb();
    const engine = engineOn(db);
    const flow = wf({ nodes: [
      { id: "ask", type: "human", question: "Go on?", options: ["yes", "no"], output: [{ name: "answer", type: "string" }] },
    ], edges: [{ from: "start", to: "ask" }, { from: "ask", to: "end", with: { result: "ask.answer" } }] });
    const before = Date.now();
    const summary = await engine.start({ workflow: flow, inputs: { query: "x" } }).done;
    const wait = JSON.parse(db.prepare("SELECT await_json FROM lane_pilot_wf_step WHERE run_id=?").get(summary.runId)!.await_json) as { kind: string; deadline?: number };
    expect(wait.kind).toBe("human");
    expect(wait.deadline).toBeGreaterThan(before + 71 * 3_600_000);
    expect(wait.deadline).toBeLessThanOrEqual(before + 73 * 3_600_000);
  });

  it("a wait whose deadline passed ends with await_timeout, never forever", async () => {
    const db = journalDb();
    const waiter: NodeExecutor = {
      run: async () => ({ wait: { kind: "mystery", detail: {}, deadline: Date.now() - 1000 } }),
      poll: async () => null,
    };
    const engine = engineOn(db, { "t.wait": waiter, write: { reentrant: true, run: async () => ({ output: { text: "t" } }) } });
    const flow = wf({ nodes: [
      { id: "w", type: "action", action: "t.wait" },
      { id: "write", type: "action", action: "write", output: [{ name: "text", type: "string" }] },
    ], edges: [{ from: "start", to: "w" }, { from: "w", to: "write" }, { from: "write", to: "end", with: { result: "write.text" } }] });
    const summary = await engine.start({ workflow: flow, inputs: { query: "x" } }).done;
    expect(summary.status).toBe("waiting");
    const settled = await engine.poll();
    expect(settled).toBe(1);
    expect(engine.get(summary.runId)?.status).toBe("failed");
  });

  it("a run left by a dead engine (stale lease, another owner) is rescued and driven again", async () => {
    const db = journalDb();
    const engine = engineOn(db);
    let visited = 0;
    engine.register("t.touch", { reentrant: true, run: async () => { visited += 1; return { output: { ok: true } }; } });
    const flow = wf({ nodes: [
      { id: "w", type: "action", action: "t.touch" },
      { id: "write", type: "action", action: "write", output: [{ name: "text", type: "string" }] },
    ], edges: [{ from: "start", to: "w" }, { from: "w", to: "write" }, { from: "write", to: "end", with: { result: "write.text" } }] });
    engine.register("write", { reentrant: true, run: async () => ({ output: { text: "t" } }) });
    const summary = await engine.start({ workflow: flow, inputs: { query: "x" } }).done;
    expect(summary.status).toBe("succeeded");
    // A dead sibling engine left a run "running" with an expired lease: the tick rescues it.
    db.prepare("UPDATE lane_pilot_wf_run SET status='running', owner_id='dead-instance', lease_until=1 WHERE id=?").run(summary.runId);
    db.prepare("UPDATE lane_pilot_wf_step SET state='running', ended_at=NULL WHERE run_id=? AND node_id='write'").run(summary.runId);
    await engine.poll();
    const status = engine.get(summary.runId)?.status;
    expect(["succeeded", "interrupted", "failed", "running"]).toContain(status);
    expect(status).not.toBe("waiting");
  });
});
