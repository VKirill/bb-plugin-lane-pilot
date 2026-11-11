import { sha256 } from "./journal";
import type { RunRow } from "./journal";
import { executorKey, outputFields } from "./lower";
import { LEGACY_BUILD_STAMP } from "./engine-types";
import { asObject } from "./step-read";
import { checkStepOutput } from "./step-output";
import type { PollResult } from "./step-types";
import type { Usage } from "./usage";
import { noteUnknownUsage } from "./engine-step";
import { failStep } from "./engine-branches";
import { cancelOpenSteps } from "./run-status";
import { claim, drive, kick, release } from "./engine-drive";
import type { WorkflowEngine } from "./engine";

/** Takes up the runs a reload left: re-runs reentrant steps, interrupts the rest, routes finished steps, goes on. */
/**
 * Runs left running or waiting by a dead engine (another instance id, lease expired): their open steps move to
 * pending when the executor is reentrant, else to interrupted, and the ids are returned for the caller to drive.
 * A run with no owner or a live lease is not stale — it is either driven or waiting to be polled.
 */
export function rescueStale(engine: WorkflowEngine): string[] {
  const rows = engine.journal.db.prepare("SELECT * FROM lane_pilot_wf_run WHERE status IN ('running','waiting') AND owner_id IS NOT NULL AND owner_id<>? AND lease_until<?").all(engine.instanceId, engine.now()) as RunRow[];
  const rescued: string[] = [];
  for (const row of rows) {
    if (engine.drives.has(row.id) || !claim(engine, row.id)) continue;
    const c = engine.compiled(row);
    for (const step of engine.journal.steps(row.id).filter((item) => item.state === "running")) {
      const node = c.nodes.get(step.node_id);
      const executor = node ? engine.executors.get(executorKey(node) ?? "") : undefined;
      const compatible = step.harness_version === engine.compat;
      if (executor?.reentrant && compatible) { engine.journal.moveStep(row.id, step.step_key, "running", "pending"); continue; }
      engine.journal.moveStep(row.id, step.step_key, "running", "interrupted", { error: "interrupted: the driving engine is gone (stale lease)", ended: true });
      engine.journal.setRunStatus(row.id, ["running"], "interrupted", `step_interrupted:${step.node_id}:stale_lease`);
      cancelOpenSteps(engine, row.id);
    }
    release(engine, row.id);
    rescued.push(row.id);
  }
  return rescued;
}

export async function resume(engine: WorkflowEngine, options: { takeOver?: boolean; runtimeFor?: (run: RunRow) => unknown } = {}): Promise<string[]> {
  const j = engine.journal;
  const taken: string[] = [];
  const rows = j.db.prepare("SELECT * FROM lane_pilot_wf_run WHERE status IN ('running','waiting')").all() as RunRow[];
  for (const row of rows) {
    if (engine.drives.has(row.id)) continue;
    if (options.takeOver) j.db.prepare("UPDATE lane_pilot_wf_run SET owner_id=NULL, lease_until=0 WHERE id=?").run(row.id);
    if (!claim(engine, row.id)) continue;
    taken.push(row.id);
    // A run whose runtime this engine still holds was not lost to a reload: the periodic tick only finds it waiting. Interrupting it
    // canceled the writer step of a live task, and the run failed `dead_end` (60 lp-task-pipeline runs on the hub, 2026-10-30/31).
    const held = engine.runtimes.has(row.id);
    if (options.runtimeFor && !held) engine.runtimes.set(row.id, options.runtimeFor(row));
    const c = engine.compiled(row);
    if (!held && engine.options.resumePolicy?.(row) === "interrupt") {
      for (const step of j.steps(row.id).filter((item) => item.state === "running")) j.moveStep(row.id, step.step_key, "running", "interrupted", { error: "interrupted by a reload", ended: true });
      j.setRunStatus(row.id, ["running", "waiting"], "interrupted", "interrupted_by_reload");
      cancelOpenSteps(engine, row.id);
      release(engine, row.id);
      continue;
    }
    for (const step of j.steps(row.id).filter((item) => item.state === "running")) {
      const node = c.nodes.get(step.node_id);
      const executor = node ? engine.executors.get(executorKey(node) ?? "") : undefined;
      const compatible = step.harness_version === engine.compat || (engine.options.compatVersion !== undefined && LEGACY_BUILD_STAMP.test(step.harness_version ?? ""));
      if (executor?.reentrant && compatible) { j.moveStep(row.id, step.step_key, "running", "pending"); continue; }
      const why = executor?.reentrant ? "harness_changed" : "not_reentrant";
      const detail = executor?.reentrant ? `: the step began under engine ${step.harness_version ?? "unknown"}, this one is ${engine.compat}` : "";
      j.moveStep(row.id, step.step_key, "running", "interrupted", { error: `interrupted by a reload (${why}${detail})`, ended: true });
      j.setRunStatus(row.id, ["running"], "interrupted", `step_interrupted:${step.node_id}:${why}`);
      cancelOpenSteps(engine, row.id);
    }
    release(engine, row.id);
  }
  for (const id of taken) drive(engine, id).catch((cause) => engine.log(`run ${id} stopped: ${cause instanceof Error ? cause.message : String(cause)}`));
  return taken;
}

/** Asks every waiting step whether what it waits for is over; settles and continues the runs it can. */
export async function poll(engine: WorkflowEngine): Promise<number> {
  // chains-end: a run whose driver died keeps "running"/"waiting" until somebody reclaims it; the tick rescues
  // only runs owned by ANOTHER instance whose lease expired — a live or unowned run is never touched.
  for (const id of rescueStale(engine)) await drive(engine, id).catch((cause: unknown) => engine.log(`run ${id} stopped: ${cause instanceof Error ? cause.message : String(cause)}`));
  const j = engine.journal;
  const rows = j.db.prepare(`SELECT s.run_id AS runId, s.step_key AS stepKey FROM lane_pilot_wf_step s JOIN lane_pilot_wf_run r ON r.id=s.run_id
    WHERE s.state='waiting' AND r.status IN ('waiting','running') ORDER BY s.rowid`).all() as Array<{ runId: string; stepKey: string }>;
  let settled = 0;
  const touched = new Set<string>();
  for (const row of rows) {
    if (engine.stopped()) break;
    const run = j.getRun(row.runId)!, step = j.getStep(row.runId, row.stepKey)!;
    const node = engine.compiled(run).nodes.get(step.node_id);
    const executor = node ? engine.executors.get(executorKey(node) ?? "") : undefined;
    if (!node || !executor?.poll) continue;
    const wait = asObject(step.await_json) as { kind: string; detail?: unknown; deadline?: number };
    let result: PollResult;
    try { result = await executor.poll({ runId: row.runId, stepKey: row.stepKey, nodeId: node.id, await: wait }, { runtime: engine.runtimes.get(row.runId) ?? engine.options.runtimeFor?.(run), node }); }
    catch (cause) { engine.log(`poll of ${row.runId}/${row.stepKey} failed: ${cause instanceof Error ? cause.message : String(cause)}`); continue; }
    // Any wait whose deadline passed and whose poll has nothing newer ends with an explicit timeout error —
    // never an eternal wait (chains-end: the attempt waits and the human defaults set this deadline).
    if (!result && typeof wait.deadline === "number" && engine.now() >= wait.deadline) result = { error: `await_timeout:${wait.kind}` };
    if (!result) continue;
    if (settle(engine, row.runId, row.stepKey, result)) { settled += 1; touched.add(row.runId); }
  }
  await Promise.allSettled([...touched].map((id) => kick(engine, id)));
  return settled;
}

/** Settles a waiting step from outside (a human answered, an attempt ended); false when it is not waiting any more. */
export function resolve(engine: WorkflowEngine, runId: string, stepKey: string, output: Record<string, unknown>): Promise<boolean> {
  const ok = settle(engine, runId, stepKey, { output });
  return ok ? kick(engine, runId).then(() => true) : Promise.resolve(false);
}

export function settle(engine: WorkflowEngine, runId: string, stepKey: string, result: { output: Record<string, unknown>; usage?: Usage; threadId?: string | null } | { error: string }): boolean {
  const j = engine.journal;
  const run = j.getRun(runId), step = j.getStep(runId, stepKey);
  if (!run || !step || step.state !== "waiting") return false;
  const c = engine.compiled(run), node = c.nodes.get(step.node_id)!;
  return j.db.transaction(() => {
    if ("error" in result) {
      if (!j.moveStep(runId, stepKey, "waiting", "failed", { error: result.error, ended: true })) return false;
      failStep(engine, runId, c, stepKey, `step_failed:${node.id}`, result.error);
      return true;
    }
    let output: Record<string, unknown>;
    try { output = checkStepOutput(node, outputFields(c.wf, node), result.output); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!j.moveStep(runId, stepKey, "waiting", "failed", { error: message, ended: true })) return false;
      failStep(engine, runId, c, stepKey, `output_invalid:${node.id}`, message);
      return true;
    }
    const prior = asObject(step.receipt_json);
    const outputJson = JSON.stringify(output);
    if (!j.moveStep(runId, stepKey, "waiting", "succeeded", { output_json: outputJson, ended: true,
      receipt_json: JSON.stringify({ ...prior, outputSha256: sha256(outputJson), threadId: result.threadId ?? prior.threadId ?? null, settledBy: "outside" }) })) return false;
    if (result.usage) {
      j.db.prepare("UPDATE lane_pilot_wf_run SET tokens_used=tokens_used+?, cost_micro_usd=cost_micro_usd+? WHERE id=?").run(Math.round(result.usage.tokens ?? 0), Math.round((result.usage.costUsd ?? 0) * 1_000_000), runId);
      if (result.usage.unknown) j.event(runId, stepKey, "usage", null, "unknown", null);
      noteUnknownUsage(engine, runId, stepKey, result.usage);
    }
    if (run.status === "waiting") j.db.prepare("UPDATE lane_pilot_wf_run SET wait_ms=wait_ms+? WHERE id=?").run(Math.max(0, engine.now() - run.updated_at), runId);
    j.setRunStatus(runId, ["waiting"], "running", null);
    return true;
  })();
}

export function cancel(engine: WorkflowEngine, runId: string, reason = "canceled"): boolean {
  const ok = engine.journal.setRunStatus(runId, ["running", "waiting"], "canceled", reason);
  if (ok) {
    engine.aborts.get(runId)?.abort(); cancelOpenSteps(engine, runId);
    // A child run has its own status and controller: a stop from above ends it too, or it goes on to its next effect (2026-10-29 audit A-002).
    for (const child of engine.journal.db.prepare("SELECT id FROM lane_pilot_wf_run WHERE parent_run_id=?").all(runId) as Array<{ id: string }>) cancel(engine, child.id, reason);
  }
  return ok;
}

