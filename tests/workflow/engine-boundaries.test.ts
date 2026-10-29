import { describe, expect, it } from "vitest";
import { engineOn, journalDb, ok, wf } from "./engine-helpers";

// The 2026-10-29 full-code audit (Аудит GPT), probes A-001 and A-002, kept as regressions.
describe("workflow engine boundaries", () => {
  it("audits the goals again when a re-run node changed the output of a run that passed", async () => {
    const db = journalDb(); let value = "valid"; let audited = 0;
    const engine = engineOn(db, { search: ok(() => ({ items: [], count: 0, kind: "fresh" })), write: ok(() => ({ text: value })) }, {
      auditGoals: async ({ output }) => { audited++; return output.result === "valid" ? { met: ["g1"], unmet: [] } : { met: [], unmet: [{ id: "g1", why: "output is invalid" }] }; },
    });
    try {
      const run = engine.start({ workflow: wf(), inputs: { query: "q" }, goals: [{ id: "g1", done_when: "result is valid", evidence: "result" }] });
      expect((await run.done).status).toBe("succeeded");
      value = "invalid";
      expect(await engine.rerunNode(run.runId, "write")).toMatchObject({ ok: true });
      await engine.idle();
      expect(engine.get(run.runId)).toMatchObject({ status: "blocked", output: { result: "invalid" } });
      expect(audited).toBe(2);
    } finally { engine.dispose(); db.close(); }
  });

  it("reuses a pass when the output did not change", async () => {
    const db = journalDb(); let audited = 0;
    const engine = engineOn(db, { search: ok(() => ({ items: [], count: 0, kind: "fresh" })), write: ok(() => ({ text: "valid" })) }, {
      auditGoals: async () => { audited++; return { met: ["g1"], unmet: [] }; },
    });
    try {
      const run = engine.start({ workflow: wf(), inputs: { query: "q" }, goals: [{ id: "g1", done_when: "result is valid", evidence: "result" }] });
      expect((await run.done).status).toBe("succeeded");
      expect(await engine.rerunNode(run.runId, "write")).toMatchObject({ ok: true });
      await engine.idle();
      expect(engine.get(run.runId)?.status).toBe("succeeded");
      expect(audited).toBe(1);
    } finally { engine.dispose(); db.close(); }
  });

  it("cancels the waiting child and grandchild runs with their parent: no child goes on to its next effect", async () => {
    const db = journalDb(); let effects = 0;
    const leaf = wf({ id: "leaf", nodes: [
      { id: "wait", type: "action", action: "wait", output: [{ name: "text", type: "string" }] },
      { id: "effect", type: "action", action: "effect", output: [{ name: "text", type: "string" }] },
    ], edges: [{ from: "start", to: "wait" }, { from: "wait", to: "effect" }, { from: "effect", to: "end", with: { result: "effect.text" } }] });
    const middle = wf({ id: "middle", nodes: [{ id: "call", type: "subworkflow", workflow: "leaf", inputs: { query: "$inputs.query" } }],
      edges: [{ from: "start", to: "call" }, { from: "call", to: "end", with: { result: "call.result" } }] });
    const parent = wf({ id: "parent", nodes: [{ id: "call", type: "subworkflow", workflow: "middle", inputs: { query: "$inputs.query" } }],
      edges: [{ from: "start", to: "call" }, { from: "call", to: "end", with: { result: "call.result" } }] });
    const engine = engineOn(db, { wait: { reentrant: true, run: async () => ({ wait: { kind: "external" } }) }, effect: ok(() => { effects++; return { text: "done" }; }) },
      { resolveWorkflow: (id) => (id === "middle" ? middle : id === "leaf" ? leaf : null) });
    try {
      const run = engine.start({ workflow: parent, inputs: { query: "q" } });
      expect((await run.done).status).toBe("waiting");
      const child = db.prepare("SELECT id FROM lane_pilot_wf_run WHERE parent_run_id=?").get(run.runId) as { id: string };
      const grandchild = db.prepare("SELECT id FROM lane_pilot_wf_run WHERE parent_run_id=?").get(child.id) as { id: string };
      expect(engine.cancel(run.runId)).toBe(true);
      const step = engine.snapshot(grandchild.id)!.steps.find((row) => row.state === "waiting");
      if (step) await engine.resolve(grandchild.id, step.step_key, { text: "continue" }).catch(() => undefined);
      await engine.idle();
      expect(effects).toBe(0);
      expect([engine.get(child.id)?.status, engine.get(grandchild.id)?.status]).toEqual(["canceled", "canceled"]);
    } finally { engine.dispose(); db.close(); }
  });
});
