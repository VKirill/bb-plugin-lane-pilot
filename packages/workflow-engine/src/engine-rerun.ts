import { TERMINAL_RUN } from "./journal";
import { asObject } from "./step-read";
import type { StepInput } from "./step-types";
import { kick } from "./engine-drive";
import type { WorkflowEngine } from "./engine";

/**
 * The owner re-runs one node of a finished run: the node's last step goes back to pending, everything that came out of it (the
 * steps it routed to, their branches, the joins that waited for it, the child runs, the effects) is removed, and the run goes on
 * from there. A canceled step that was waiting for its turn when the run ended is revived. Refused while the run is active, for a
 * child run (re-run from its parent) and for a node that never ran. The new try has its own spawn key, so an agent step opens a new thread.
 * `runtime`: the caller's own state for the steps that go again (the dispatch pipeline keeps the task there); it replaces the one the run had.
 * `patch`: corrected inputs of the node, merged over the ones its step had (Maslov's live correction: fix the step's input and go on
 * on the same branch, keeping every step before it). The journal names the keys changed.
 */
export async function rerunNode(engine: WorkflowEngine, runId: string, nodeId: string, runtime?: unknown, patch?: Record<string, unknown>): Promise<{ ok: true; stepKey: string; removed: number } | { ok: false; reason: string }> {
  const j = engine.journal;
  const run = j.getRun(runId);
  if (!run) return { ok: false, reason: "not_found" };
  if (!TERMINAL_RUN.includes(run.status) || engine.drives.has(runId)) return { ok: false, reason: "run_active" };
  if (run.parent_run_id) return { ok: false, reason: "child_run" };
  const c = engine.compiled(run);
  if (!c.nodes.has(nodeId)) return { ok: false, reason: "unknown_node" };
  const steps = j.steps(runId);
  const target = [...steps].reverse().find((step) => step.node_id === nodeId && step.state !== "pending");
  if (!target) return { ok: false, reason: "node_not_run" };
  if (target.state === "running" || target.state === "waiting") return { ok: false, reason: "step_active" };

  const gone = new Set<string>();
  const arrivals = j.db.prepare("SELECT group_key, from_step FROM lane_pilot_wf_arrival WHERE run_id=?").all(runId) as Array<{ group_key: string; from_step: string }>;
  for (let grew = true; grew;) {
    grew = false;
    for (const step of steps) {
      if (step.step_key === target.step_key || gone.has(step.step_key)) continue;
      const fedBy = step.parent_key !== null && (step.parent_key === target.step_key || gone.has(step.parent_key));
      // A join waited for the branches of its parallel: when a branch arrival goes, the join goes with it.
      const joinOfGone = step.parent_key !== null && c.nodes.get(step.node_id)?.type === "join" && arrivals.some((row) => row.group_key === step.parent_key && (row.from_step === target.step_key || gone.has(row.from_step)));
      if (fedBy || joinOfGone) { gone.add(step.step_key); grew = true; }
    }
  }
  const doomed = new Set([target.step_key, ...gone]);
  const childRuns = (id: string): string[] => {
    const rows = j.db.prepare("SELECT id FROM lane_pilot_wf_run WHERE parent_run_id=?").all(id) as Array<{ id: string }>;
    return rows.flatMap((row) => [row.id, ...childRuns(row.id)]);
  };
  const attached = (j.db.prepare("SELECT id, parent_step_key FROM lane_pilot_wf_run WHERE parent_run_id=?").all(runId) as Array<{ id: string; parent_step_key: string }>)
    .filter((row) => doomed.has(row.parent_step_key)).flatMap((row) => [row.id, ...childRuns(row.id)]);
  const started = [...doomed].filter((key) => steps.find((step) => step.step_key === key)?.state !== "pending").length;
  const input = asObject(target.input_json) as unknown as StepInput;
  const patched = Object.keys(patch ?? {});
  const nextInput = JSON.stringify({ ...input, ...(patched.length ? { with: { ...input.with, ...patch } } : {}), rerun: (input.rerun ?? 0) + 1 });

  j.db.transaction(() => {
    const marks = (list: string[]) => list.map(() => "?").join(",");
    const dropped = [...gone], all = [target.step_key, ...dropped];
    for (const child of attached) {
      for (const table of ["lane_pilot_wf_step", "lane_pilot_wf_arrival", "lane_pilot_wf_effect"]) j.db.prepare(`DELETE FROM ${table} WHERE run_id=?`).run(child);
      j.db.prepare("DELETE FROM lane_pilot_wf_run WHERE id=?").run(child);
    }
    if (dropped.length) j.db.prepare(`DELETE FROM lane_pilot_wf_step WHERE run_id=? AND step_key IN (${marks(dropped)})`).run(runId, ...dropped);
    j.db.prepare(`DELETE FROM lane_pilot_wf_arrival WHERE run_id=? AND (from_step IN (${marks(all)}) OR group_key IN (${marks(all)}))`).run(runId, ...all, ...all);
    j.db.prepare(`DELETE FROM lane_pilot_wf_effect WHERE run_id=? AND step_key IN (${marks(all)})`).run(runId, ...all);
    j.db.prepare(`UPDATE lane_pilot_wf_step SET state='pending', attempt=0, input_json=?, output_json=NULL, error=NULL, await_json=NULL, spawn_key=NULL, receipt_json=NULL,
      routed=0, fan_count=NULL, started_at=NULL, ended_at=NULL, updated_at=? WHERE run_id=? AND step_key=?`).run(nextInput, engine.now(), runId, target.step_key);
    for (const step of steps) {
      if (doomed.has(step.step_key) || step.state !== "canceled" || step.error !== null) continue;
      j.db.prepare("UPDATE lane_pilot_wf_step SET state='pending', ended_at=NULL, updated_at=? WHERE run_id=? AND step_key=?").run(engine.now(), runId, step.step_key);
    }
    j.db.prepare("UPDATE lane_pilot_wf_run SET status='running', reason=NULL, output_json=NULL, steps_used=MAX(0, steps_used-?), owner_id=NULL, lease_until=0, updated_at=? WHERE id=?").run(started, engine.now(), runId);
    j.event(runId, target.step_key, "rerun", target.state, "pending", `node ${nodeId}: ${doomed.size} step(s) reset or removed${patched.length ? `; inputs corrected: ${patched.join(", ")}` : ""}`);
  })();
  engine.compiledRuns.delete(runId);
  if (runtime !== undefined) engine.runtimes.set(runId, runtime);
  engine.aborts.set(runId, new AbortController()); // a failed or blocked run fired its controller; the re-run's steps and goal audit need a live one
  void kick(engine, runId).catch((cause) => engine.log(`run ${runId} stopped after a re-run: ${cause instanceof Error ? cause.message : String(cause)}`));
  return { ok: true, stepKey: target.step_key, removed: gone.size };
}
