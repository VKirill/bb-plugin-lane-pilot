import { TERMINAL_RUN } from "./journal";
import type { RunSummary } from "./engine-types";
import { failRun, summary } from "./run-status";
import { routeAll } from "./engine-routing";
import { gates } from "./engine-branches";
import { checkLimits, execStep } from "./engine-step";
import { closeAfterAudit } from "./engine-goal-audit";
import type { WorkflowEngine } from "./engine";

/** How many finished runs keep their compiled graph and runtime in memory. */
const RETAINED_RUNS = 64;

export function drive(engine: WorkflowEngine, runId: string): Promise<RunSummary> {
  const running = engine.drives.get(runId);
  if (running) return running;
  const promise = driveLoop(engine, runId).finally(() => { engine.drives.delete(runId); retire(engine, runId); });
  engine.drives.set(runId, promise);
  return promise;
}

/** Resolves when every run this instance is driving has stopped. */
export async function idle(engine: WorkflowEngine): Promise<void> { while (engine.drives.size) await Promise.allSettled([...engine.drives.values()]); }

/**
 * Drives a run after something settled one of its steps. A drive that is just ending (it saw the step waiting a moment ago) would
 * be handed back by `drive` and leave the run `running` with nobody driving it, so it is waited for first and the run is driven again.
 */
export async function kick(engine: WorkflowEngine, runId: string): Promise<RunSummary> {
  const running = engine.drives.get(runId);
  // the in-flight drive's own error path already recorded its failure; here we only wait for it to settle
  if (running) await running.catch(() => undefined);
  return drive(engine, runId);
}

export function claim(engine: WorkflowEngine, runId: string): boolean {
  const at = engine.now();
  const result = engine.options.db.prepare(`UPDATE lane_pilot_wf_run SET owner_id=?, lease_until=? WHERE id=? AND status IN ('running','waiting') AND (owner_id IS NULL OR owner_id=? OR lease_until<?)`)
    .run(engine.instanceId, at + engine.leaseMs, runId, engine.instanceId, at);
  return result.changes > 0;
}

/**
 * A finished run lets go of its abort controller, and of its compiled graph and runtime once RETAINED_RUNS newer ones finished:
 * a long-lived engine held all three for every run it ever drove (2026-10-29 audit A-010). A re-run rebuilds what is gone.
 */
export function retire(engine: WorkflowEngine, runId: string): void {
  const run = engine.journal.getRun(runId);
  if (!run || !TERMINAL_RUN.includes(run.status) || engine.drives.has(runId)) return;
  engine.aborts.delete(runId);
  if (!engine.retired.includes(runId)) engine.retired.push(runId);
  while (engine.retired.length > RETAINED_RUNS) {
    const old = engine.retired.shift()!;
    const row = engine.journal.getRun(old);
    if (row && !TERMINAL_RUN.includes(row.status)) continue;
    engine.compiledRuns.delete(old); engine.runtimes.delete(old);
  }
}

export function release(engine: WorkflowEngine, runId: string): void {
  try { engine.options.db.prepare("UPDATE lane_pilot_wf_run SET owner_id=NULL, lease_until=0 WHERE id=? AND owner_id=?").run(runId, engine.instanceId); } catch { /* the database may be closed */ }
}

export function beat(engine: WorkflowEngine, runId: string): void {
  const timer = setInterval(() => {
    try { engine.options.db.prepare("UPDATE lane_pilot_wf_run SET lease_until=? WHERE id=? AND owner_id=?").run(engine.now() + engine.leaseMs, runId, engine.instanceId); } catch { /* closed */ }
  }, Math.max(10, Math.floor(engine.leaseMs / 3)));
  timer.unref?.();
  engine.beats.set(runId, timer);
}

export function unbeat(engine: WorkflowEngine, runId: string): void { const timer = engine.beats.get(runId); if (timer) clearInterval(timer); engine.beats.delete(runId); }

export async function driveLoop(engine: WorkflowEngine, runId: string): Promise<RunSummary> {
  const j = engine.journal;
  if (!claim(engine, runId)) return summary(engine, runId);
  beat(engine, runId);
  engine.stoppedRuns.delete(runId);
  try {
    for (;;) {
      if (engine.stopped()) { engine.stoppedRuns.add(runId); break; }
      const run = j.getRun(runId);
      if (!run || TERMINAL_RUN.includes(run.status)) break;
      engine.fault("loop");
      routeAll(engine, run, engine.compiled(run));
      const routed = j.getRun(runId)!;
      if (TERMINAL_RUN.includes(routed.status)) break;
      const steps = j.steps(runId);
      const pending = steps.filter((step) => step.state === "pending");
      if (pending.length) {
        const found = gates(engine, routed, engine.compiled(routed), pending);
        // A branch blocked by a failed dependency was settled just now: route again before looking at what is ready.
        if (found.changed) continue;
        if (found.ready.length) {
          const settled = await Promise.allSettled(found.ready.map((step) => execStep(engine, runId, step.step_key)));
          const crash = settled.find((item) => item.status === "rejected") as PromiseRejectedResult | undefined;
          if (crash) throw crash.reason;
          if (settled.some((item) => item.status === "fulfilled" && item.value === "stop")) { engine.stoppedRuns.add(runId); break; }
          continue;
        }
        // Every pending step waits for a branch that has not arrived: without a running or waiting step nothing can free them.
        if (!steps.some((step) => step.state === "running" || step.state === "waiting")) { failRun(engine, runId, "deadlock: branches wait for dependencies that never arrive"); break; }
      }
      if (steps.some((step) => step.state === "waiting")) { j.setRunStatus(runId, ["running"], "waiting", null); break; }
      if (steps.some((step) => step.state === "running")) break;
      if (routed.output_json !== null) { if (await closeAfterAudit(engine, routed) === "stop") engine.stoppedRuns.add(runId); }
      else j.setRunStatus(runId, ["running", "waiting"], "failed", "dead_end: no step is left and the exit was not reached");
      break;
    }
  } finally {
    unbeat(engine, runId);
    release(engine, runId);
  }
  return summary(engine, runId);
}
