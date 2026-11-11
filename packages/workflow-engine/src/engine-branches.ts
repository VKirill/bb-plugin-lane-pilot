import type { RunRow, StepRow } from "./journal";
import type { GraphNode as WorkflowNode } from "./schema";
import type { Compiled } from "./compiled";
import { asObject } from "./step-read";
import { failRun } from "./engine-drive";
import { tryJoin } from "./engine-routing";
import type { WorkflowEngine } from "./engine";

/** The parallel a branch scope belongs to, with its join; null outside a branch. */
export function branchOf(engine: WorkflowEngine, run: RunRow, c: Compiled, step: StepRow): { group: string; branch: number; parallel: Extract<WorkflowNode, { type: "parallel" }>; join: Extract<WorkflowNode, { type: "join" }>; parentScope: string } | null {
  const last = step.scope.split("/").pop() ?? "";
  const at = last.lastIndexOf("~");
  if (at < 0) return null;
  const group = last.slice(0, at), parallelStep = engine.journal.getStep(run.id, group);
  const parallel = parallelStep ? c.nodes.get(parallelStep.node_id) : undefined;
  const join = parallel ? c.joinOf.get(parallel.id) : undefined;
  if (!parallelStep || !parallel || parallel.type !== "parallel" || !join) return null;
  return { group, branch: Number(last.slice(at + 1)), parallel, join, parentScope: parallelStep.scope };
}

/** A failed branch ends the run, unless its join takes a partial result: policy majority or all_or_low_confidence, or `on_child_fail`. */
export function tolerates(branch: { parallel: Extract<WorkflowNode, { type: "parallel" }>; join: Extract<WorkflowNode, { type: "join" }> }): boolean {
  return branch.parallel.on_child_fail !== undefined || branch.join.policy !== "all";
}

/** A branch arrives at its join as failed: the join sees it in `failed` and decides by its policy. */
export function arrive(engine: WorkflowEngine, run: RunRow, c: Compiled, branch: { group: string; branch: number; join: Extract<WorkflowNode, { type: "join" }>; parentScope: string }, stepKey: string, data: Record<string, unknown>): void {
  engine.journal.db.prepare("INSERT OR IGNORE INTO lane_pilot_wf_arrival(run_id,group_key,branch,from_step,data_json,at) VALUES (?,?,?,?,?,?)")
    .run(run.id, branch.group, branch.branch, stepKey, JSON.stringify(data), engine.now());
  engine.journal.event(run.id, stepKey, "branch_failed", null, null, String(data.$failed ?? ""));
  tryJoin(engine, run, c, branch.group, branch.join, branch.parentScope);
}

export function failStep(engine: WorkflowEngine, runId: string, c: Compiled, stepKey: string, reason: string, message: string): void {
  const run = engine.journal.getRun(runId), step = engine.journal.getStep(runId, stepKey);
  const branch = run && step ? branchOf(engine, run, c, step) : null;
  if (run && branch && tolerates(branch)) { arrive(engine, run, c, branch, stepKey, { $failed: message }); return; }
  failRun(engine, runId, reason);
}

/** Steps of an ordered parallel start when the branches they depend on have arrived; one whose dependency failed is blocked (on_child_fail). */
export function gates(engine: WorkflowEngine, run: RunRow, c: Compiled, pending: StepRow[]): { ready: StepRow[]; changed: boolean } {
  const j = engine.journal;
  const ready: StepRow[] = [];
  let changed = false;
  for (const step of pending) {
    const input = asObject(step.input_json) as { after?: number[]; group?: string };
    if (!input.after?.length || !input.group) { ready.push(step); continue; }
    const arrived = new Map((j.db.prepare("SELECT branch, data_json FROM lane_pilot_wf_arrival WHERE run_id=? AND group_key=?").all(run.id, input.group) as Array<{ branch: number; data_json: string }>)
      .map((row) => [row.branch, asObject(row.data_json)]));
    if (input.after.some((dep) => !arrived.has(dep))) continue;
    const failed = input.after.find((dep) => arrived.get(dep)!.$failed !== undefined);
    const branch = failed !== undefined ? branchOf(engine, run, c, step) : null;
    if (failed === undefined || !branch || branch.parallel.on_child_fail !== "block_dependents") { ready.push(step); continue; }
    const dependency = (asObject(j.getStep(run.id, input.group)!.input_json) as { items?: unknown[] }).items?.[failed];
    const label = typeof dependency === "object" && dependency !== null && typeof (dependency as { id?: unknown }).id === "string" ? (dependency as { id: string }).id : String(failed);
    if (!j.moveStep(run.id, step.step_key, "pending", "canceled", { error: `upstream_blocked:${label}`, ended: true })) continue;
    arrive(engine, run, c, branch, step.step_key, { $failed: `upstream_blocked:${label}`, $blocked: true });
    changed = true;
  }
  return { ready: withinConcurrency(engine, run, c, ready), changed };
}

/** `concurrency` on a fan-out: only that many branches run at once, in branch order; the first step of the others waits for a free place. */
export function withinConcurrency(engine: WorkflowEngine, run: RunRow, c: Compiled, ready: StepRow[]): StepRow[] {
  const starts = new Map<string, Array<{ step: StepRow; branch: number; limit: number }>>();
  const keep = new Set(ready.map((step) => step.step_key));
  for (const step of ready) {
    const branch = branchOf(engine, run, c, step);
    if (!branch || branch.parallel.concurrency === undefined || step.parent_key !== branch.group) continue;
    const list = starts.get(branch.group) ?? [];
    list.push({ step, branch: branch.branch, limit: branch.parallel.concurrency });
    starts.set(branch.group, list);
  }
  for (const [group, list] of starts) {
    const active = new Set<number>();
    const open = engine.journal.db.prepare("SELECT scope FROM lane_pilot_wf_step WHERE run_id=? AND state IN ('running','waiting')").all(run.id) as Array<{ scope: string }>;
    for (const row of open) { const segment = row.scope.split("/").find((part) => part.startsWith(`${group}~`)); if (segment) active.add(Number(segment.slice(group.length + 1))); }
    const room = Math.max(0, list[0]!.limit - active.size);
    for (const item of list.sort((a, b) => a.branch - b.branch).slice(room)) keep.delete(item.step.step_key);
  }
  return ready.filter((step) => keep.has(step.step_key));
}
