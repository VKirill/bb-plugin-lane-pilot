import { describe, expect, it, vi } from "vitest";
import type { RunStatus } from "@lane-pilot/workflow-engine";
import incident from "../fixtures/subworkflow-poll-gsc-2026-11-11.json";
import { engineOn, journalDb, rows, wf } from "./engine-helpers";

/** Replay the captured waiting parent / terminal child boundary without running SEO agents or asking for credentials. */
async function replay(status: RunStatus = incident.child.status as RunStatus, charged = incident.usageCharged) {
  const db = journalDb(), log = vi.fn();
  const child = wf({
    id: incident.child.workflowId,
    outputs: [{ name: "result", type: "array" }],
    nodes: [{ id: "corpus", type: "parallel", for_each: ["gsc_queries"],
      child: { type: "action", action: "corpus", output: [{ name: "text", type: "string" }] },
      join: { policy: "all", out: [{ name: "text", type: "array" }] } }],
    edges: [{ from: "start", to: "corpus" }, { from: "corpus", to: "end", with: { result: "corpus.text" } }],
  });
  const parent = wf({
    id: incident.parent.workflowId,
    outputs: [{ name: "result", type: "array" }],
    nodes: [{ id: incident.step.nodeId, type: "subworkflow", workflow: child.id, inputs: { query: "$inputs.query" }, output: [{ name: "result", type: "array" }] }],
    edges: [{ from: "start", to: incident.step.nodeId }, { from: incident.step.nodeId, to: "end", with: { result: `${incident.step.nodeId}.result` } }],
  });
  const engine = engineOn(db, { corpus: { run: async () => ({ wait: { kind: "external" } }) } }, { log, resolveWorkflow: () => child });
  const first = await engine.start({ workflow: parent, inputs: { query: "q" } }).done;
  expect(first.status).toBe(incident.parent.status);
  expect(first.waiting[0]).toMatchObject({ stepKey: incident.step.key, await: { kind: incident.step.awaiting } });
  const childRun = rows<{ id: string }>(db, "SELECT id FROM lane_pilot_wf_run WHERE parent_run_id=?", first.runId)[0]!;
  const step = engine.journal.steps(childRun.id).find((item) => item.node_id === incident.failure.nodeId)!;
  engine.journal.moveStep(childRun.id, step.step_key, "waiting", "failed", { error: incident.failure.error, ended: true });
  engine.journal.setRunStatus(childRun.id, ["waiting"], status, incident.child.reason);
  db.prepare("UPDATE lane_pilot_wf_run SET tokens_used=?, cost_micro_usd=? WHERE id=?")
    .run(incident.child.tokens, Math.round(incident.child.costUsd * 1_000_000), childRun.id);
  db.prepare("UPDATE lane_pilot_wf_run SET tokens_used=?, cost_micro_usd=? WHERE id=?")
    .run(incident.parent.tokens, Math.round(incident.parent.costUsd * 1_000_000), first.runId);
  if (charged) engine.journal.event(first.runId, childRun.id, "child_usage_charged", null, null, "captured before the failing poll");
  return { db, engine, log, runId: first.runId, childId: childRun.id };
}

describe("terminal subworkflow polling", () => {
  it("settles the real GSC failure instead of logging it on every poll, including after reload", async () => {
    const { db, runId, log } = await replay();
    // A newly loaded engine must settle an already-stuck journal too.
    const engine = engineOn(db, {}, { log });
    expect(await engine.poll()).toBe(1);
    expect(engine.get(runId)).toMatchObject({
      status: "failed", reason: "step_failed:research", failedNode: "research",
      error: `subworkflow ${incident.child.workflowId} failed: ${incident.failure.error}`,
    });
    expect(engine.journal.getStep(runId, incident.step.key)).toMatchObject({ state: "failed" });
    expect(await engine.poll()).toBe(0);
    expect(log).not.toHaveBeenCalled();
    expect(engine.journal.getRun(runId)).toMatchObject({ tokens_used: incident.parent.tokens, cost_micro_usd: Math.round(incident.parent.costUsd * 1_000_000) });
    expect(rows(db, "SELECT * FROM lane_pilot_wf_event WHERE run_id=? AND kind='child_usage_charged'", runId)).toHaveLength(1);
  });

  it.each(["blocked", "interrupted", "canceled", "not_verified"] as const)("also settles a %s child", async (status) => {
    const { engine, runId } = await replay(status);
    expect(await engine.poll()).toBe(1);
    expect(engine.get(runId)).toMatchObject({ status: "failed", error: `subworkflow ${incident.child.workflowId} ${status}: ${incident.failure.error}` });
  });

  it("charges an uncharged failed child once while settling it", async () => {
    const { db, engine, runId } = await replay("failed", false);
    expect(await engine.poll()).toBe(1);
    expect(await engine.poll()).toBe(0);
    expect(engine.journal.getRun(runId)).toMatchObject({
      tokens_used: incident.parent.tokens + incident.child.tokens,
      cost_micro_usd: Math.round((incident.parent.costUsd + incident.child.costUsd) * 1_000_000),
    });
    expect(rows(db, "SELECT * FROM lane_pilot_wf_event WHERE run_id=? AND kind='child_usage_charged'", runId)).toHaveLength(1);
  });

  it("keeps an infrastructure read error retryable instead of recording it as the child's failure", async () => {
    const { db, engine, runId, log } = await replay();
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
      if (sql === "SELECT tokens_used, cost_micro_usd FROM lane_pilot_wf_run WHERE id=?") throw new Error("database is locked");
      return prepare(sql);
    });
    expect(await engine.poll()).toBe(0);
    expect(engine.get(runId)?.status).toBe("waiting");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("database is locked"));
    spy.mockRestore();
    expect(await engine.poll()).toBe(1);
    expect(engine.get(runId)?.status).toBe("failed");
  });
});
