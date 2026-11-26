import type { RunRow, StepRow } from "./journal";
import { executorKey } from "./lower";
import { LEGACY_BUILD_STAMP } from "./engine-types";
import { asObject } from "./step-read";
import type { PollResult } from "./step-types";
import { attemptMatches, markInboxEventConsumed } from "./inbox";
import { settle } from "./engine-settle";
import { cancelOpenSteps, failRun } from "./run-status";
import { claim, drive, kick, release } from "./engine-drive";
import { stopRunChildren } from "./budgets";
import type { WorkflowEngine } from "./engine";

export { settle };

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
    let c;
    try { c = engine.compiled(row); }
    catch (cause) { failRun(engine, row.id, cause instanceof Error ? cause.message.slice(0, 300) : String(cause)); release(engine, row.id); continue; }
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
    let c;
    try { c = engine.compiled(row); }
    catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      engine.log(`run ${row.id} cannot resume: ${reason}`, "error");
      failRun(engine, row.id, reason.slice(0, 300));
      release(engine, row.id);
      taken.pop();
      continue;
    }
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
  // Overdue deadlines fire in deadline order, at most the cap now; the clock (or the next poll) takes the rest.
  await settleDue(engine, { limit: engine.overdueCap, source: "resume" });
  engine.clock?.arm();
  return taken;
}

/**
 * Fires the waiting steps whose absolute deadline has passed, oldest deadline first, at most `limit` asked per call. Each settle is a
 * compare-and-set on `state='waiting'`, so an event that arrives in the same moment still ends the step exactly once.
 */
export async function settleDue(engine: WorkflowEngine, options: { limit: number; source: "resume" | "clock" }): Promise<number> {
  const j = engine.journal;
  const due = j.db.prepare(`SELECT s.run_id AS runId, s.step_key AS stepKey, json_extract(s.await_json,'$.deadline') AS deadline FROM lane_pilot_wf_step s
    JOIN lane_pilot_wf_run r ON r.id=s.run_id WHERE s.state='waiting' AND r.status IN ('waiting','running')
      AND json_type(s.await_json,'$.deadline') IN ('integer','real') AND json_extract(s.await_json,'$.deadline')<=?
    ORDER BY deadline, s.rowid LIMIT ?`).all(engine.now(), options.limit) as Array<{ runId: string; stepKey: string; deadline: number }>;
  let settled = 0;
  const touched = new Set<string>();
  for (const row of due) {
    if (engine.stopped()) break;
    const run = j.getRun(row.runId), step = j.getStep(row.runId, row.stepKey);
    if (!run || !step || step.state !== "waiting") continue;
    if (options.source === "resume") engine.log(`wf.wait overdue on resume step=${row.runId}/${row.stepKey} fired late by ${Math.max(0, engine.now() - row.deadline)}ms`, "warn");
    if (await settleWaitingStep(engine, run, step, { unlimited: true })) { settled += 1; touched.add(row.runId); }
  }
  await Promise.allSettled([...touched].map((id) => kick(engine, id)));
  return settled;
}

async function settleWaitingStep(engine: WorkflowEngine, run: RunRow, step: StepRow, limit: { budget?: { timeouts: number }; unlimited?: boolean } = {}): Promise<boolean> {
  const node = engine.compiled(run).nodes.get(step.node_id);
  if (!node) return false;
  const executor = engine.executors.get(executorKey(node) ?? "");
  const wait = asObject(step.await_json) as { kind: string; detail?: unknown; deadline?: number; timeoutOutput?: Record<string, unknown> };
  let result: PollResult = null;
  if (executor?.poll) {
    try {
      result = await executor.poll(
        { runId: run.id, stepKey: step.step_key, nodeId: node.id, await: wait },
        { runtime: engine.runtimes.get(run.id) ?? engine.options.runtimeFor?.(run), node },
      );
    } catch (cause) {
      engine.log(`poll of ${run.id}/${step.step_key} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      return false;
    }
  }
  const expired = typeof wait.deadline === "number" && engine.now() >= wait.deadline;
  let timedOut = false;
  if (!result && expired) {
    // After an outage the poll fires only a capped number of pure timeouts; the clock's next tick takes the rest.
    if (!limit.unlimited && limit.budget && limit.budget.timeouts-- <= 0) return false;
    // Any wait whose deadline passed and whose poll has nothing newer ends with its timeoutOutput or an explicit timeout error —
    // never an eternal wait (chains-end: the attempt waits and the human defaults set this deadline).
    result = wait.timeoutOutput ? { output: wait.timeoutOutput } : { error: `await_timeout:${wait.kind}` };
    timedOut = true;
  } else if (result && expired && (executorKey(node) === "builtin:wait" || executorKey(node) === "builtin:human")) {
    timedOut = true;
  }
  if (!result) return false;
  return settle(engine, run.id, step.step_key, result, { by: timedOut ? "timeout" : "event" });
}

/** Asks every waiting step whether what it waits for is over; settles and continues the runs it can. */
export async function poll(engine: WorkflowEngine): Promise<number> {
  // chains-end: a run whose driver died keeps "running"/"waiting" until somebody reclaims it; the tick rescues
  // only runs owned by ANOTHER instance whose lease expired — a live or unowned run is never touched.
  for (const id of rescueStale(engine)) await drive(engine, id).catch((cause: unknown) => engine.log(`run ${id} stopped: ${cause instanceof Error ? cause.message : String(cause)}`));
  const j = engine.journal;
  const rows = j.db.prepare(`SELECT s.run_id AS runId, s.step_key AS stepKey FROM lane_pilot_wf_step s JOIN lane_pilot_wf_run r ON r.id=s.run_id
    WHERE s.state='waiting' AND r.status IN ('waiting','running') ORDER BY COALESCE(json_extract(s.await_json,'$.deadline'), 9e18), s.rowid`).all() as Array<{ runId: string; stepKey: string }>;
  let settled = 0;
  const touched = new Set<string>();
  const budget = { timeouts: engine.overdueCap };
  for (const row of rows) {
    if (engine.stopped()) break;
    const run = j.getRun(row.runId)!, step = j.getStep(row.runId, row.stepKey)!;
    if (await settleWaitingStep(engine, run, step, { budget })) { settled += 1; touched.add(row.runId); }
  }
  await Promise.allSettled([...touched].map((id) => kick(engine, id)));
  return settled;
}

/**
 * Asks only the waiting steps of one kind whose wait detail matches `detail` (e.g. the `attempt` waits of one task) whether what they
 * wait for is over. An event that changes a state such a step reads (a canceled retry) calls it instead of a whole-engine poll.
 */
export async function recheck(engine: WorkflowEngine, kind: string, detail: Record<string, string>): Promise<number> {
  const entries = Object.entries(detail);
  if (entries.some(([key]) => !/^[A-Za-z_]\w*$/.test(key))) throw new Error(`recheck: bad detail key in ${entries.map(([key]) => key).join(",")}`);
  const j = engine.journal;
  const rows = j.db.prepare(`SELECT s.run_id AS runId, s.step_key AS stepKey FROM lane_pilot_wf_step s JOIN lane_pilot_wf_run r ON r.id=s.run_id
    WHERE s.state='waiting' AND r.status IN ('waiting','running') AND json_extract(s.await_json,'$.kind')=?
    ${entries.map(([key]) => `AND json_extract(s.await_json,'$.detail.${key}')=?`).join(" ")} ORDER BY s.rowid`)
    .all(kind, ...entries.map(([, value]) => value)) as Array<{ runId: string; stepKey: string }>;
  let settled = 0;
  const touched = new Set<string>();
  for (const row of rows) {
    if (engine.stopped()) break;
    const run = j.getRun(row.runId), step = j.getStep(row.runId, row.stepKey);
    if (!run || !step || step.state !== "waiting") continue;
    if (await settleWaitingStep(engine, run, step)) { settled += 1; touched.add(row.runId); }
  }
  await Promise.allSettled([...touched].map((id) => kick(engine, id)));
  return settled;
}

/** Settles a waiting step from outside (a human answered, an attempt ended); false when it is not waiting any more. */
export function resolve(engine: WorkflowEngine, runId: string, stepKey: string, output: Record<string, unknown>): Promise<boolean> {
  const ok = settle(engine, runId, stepKey, { output }, { by: "event" });
  return ok ? kick(engine, runId).then(() => true) : Promise.resolve(false);
}

/**
 * Resolves all waiting steps whose `await_json` matches `(kind, eventKey)` through `resolve()`,
 * enforcing attempt fencing when an attempt key is present on the wait or the run.
 */
export async function wake(
  engine: WorkflowEngine,
  kind: string,
  eventKey: string,
  output: Record<string, unknown>,
  options: { eventId?: string; attemptKey?: string } = {},
): Promise<number> {
  const j = engine.journal;
  const rows = j.db.prepare(`SELECT s.run_id AS runId, s.step_key AS stepKey, s.await_json AS awaitJson, r.link_attempt_id AS linkAttemptId
    FROM lane_pilot_wf_step s JOIN lane_pilot_wf_run r ON r.id=s.run_id
    WHERE s.state='waiting' AND r.status IN ('waiting','running')
      AND json_extract(s.await_json,'$.kind')=?
      AND json_extract(s.await_json,'$.eventKey')=?
    ORDER BY s.rowid`).all(kind, eventKey) as Array<{ runId: string; stepKey: string; awaitJson: string | null; linkAttemptId: string | null }>;

  const eventAttemptKey = options.attemptKey ?? (typeof output.attemptKey === "string" && output.attemptKey ? output.attemptKey : undefined);
  let woken = 0;
  for (const row of rows) {
    if (engine.stopped()) break;
    const wait = asObject(row.awaitJson) as { attemptKey?: unknown };
    const stepAttemptKey = typeof wait.attemptKey === "string" && wait.attemptKey ? wait.attemptKey : undefined;
    if (!attemptMatches(stepAttemptKey, row.linkAttemptId ?? undefined, eventAttemptKey)) {
      engine.log(`wf.event refused stale attempt kind=${kind} key=${eventKey} step=${row.runId}/${row.stepKey} expected=${stepAttemptKey ?? row.linkAttemptId} got=${eventAttemptKey ?? "none"}`);
      continue;
    }
    if (await resolve(engine, row.runId, row.stepKey, output)) {
      woken += 1;
      if (options.eventId) markInboxEventConsumed(j.db, options.eventId, `${row.runId}:${row.stepKey}`);
    }
  }
  return woken;
}

export function cancel(engine: WorkflowEngine, runId: string, reason = "canceled"): boolean {
  const ok = engine.journal.setRunStatus(runId, ["running", "waiting"], "canceled", reason);
  if (ok) {
    engine.aborts.get(runId)?.abort(); cancelOpenSteps(engine, runId);
    void stopRunChildren(engine, runId);
    // A child run has its own status and controller: a stop from above ends it too, or it goes on to its next effect (2026-10-29 audit A-002).
    for (const child of engine.journal.db.prepare("SELECT id FROM lane_pilot_wf_run WHERE parent_run_id=?").all(runId) as Array<{ id: string }>) cancel(engine, child.id, reason);
  }
  return ok;
}

export async function stopRun(engine: WorkflowEngine, runId: string, reason = "canceled"): Promise<{ stopped: boolean; childrenKilled: number }> {
  const stopped = cancel(engine, runId, reason);
  const childrenKilled = await stopRunChildren(engine, runId);
  return { stopped, childrenKilled };
}

