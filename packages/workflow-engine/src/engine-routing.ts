import { MissingValueError, evalCondition, parseExpr, refOf } from "./expr";
import { stableId, TERMINAL_RUN } from "./journal";
import type { RunRow, StepRow } from "./journal";
import { END } from "./schema";
import type { GraphNode as WorkflowNode, PassMode, WorkflowEdge } from "./schema";
import type { Compiled } from "./compiled";
import { RouteFailure } from "./engine-errors";
import { asObject, env, mapWith } from "./step-read";
import type { StepInput } from "./step-types";
import { failRun } from "./run-status";
import type { WorkflowEngine } from "./engine";

export function routeAll(engine: WorkflowEngine, run: RunRow, c: Compiled): void {
  const j = engine.journal;
  for (const step of j.steps(run.id)) {
    if ((step.state !== "succeeded" && step.state !== "skipped") || step.routed) continue;
    try {
      j.db.transaction(() => {
        engine.fault("before-route");
        const node = c.nodes.get(step.node_id)!;
        if (node.type === "parallel") routeParallel(engine, run, c, step, node);
        else routeEdges(engine, run, c, step, node);
        j.db.prepare("UPDATE lane_pilot_wf_step SET routed=1 WHERE run_id=? AND step_key=?").run(run.id, step.step_key);
        engine.fault("after-route");
      })();
    } catch (cause) {
      if (cause instanceof RouteFailure) { failRun(engine, run.id, `${cause.code}:${step.node_id}: ${cause.message}`); return; }
      if (cause instanceof MissingValueError) { failRun(engine, run.id, `${cause.code}:${step.node_id}: ${cause.message}`); return; }
      throw cause;
    }
    if (TERMINAL_RUN.includes(j.getRun(run.id)!.status)) return;
  }
}

export function visitsOf(engine: WorkflowEngine, runId: string, nodeId: string, scope: string): number {
  return (engine.journal.db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_wf_step WHERE run_id=? AND node_id=? AND scope=?").get(runId, nodeId, scope) as { n: number }).n;
}

export function routeEdges(engine: WorkflowEngine, run: RunRow, c: Compiled, step: StepRow, node: WorkflowNode): void {
  const out = c.out.get(node.id) ?? [];
  const scope = env(engine, run, step);
  const matching = out.filter((item) => { const expr = c.when.get(item.index); return expr !== undefined && evalCondition(expr, scope, `${node.id} -> ${item.edge.to}`); });
  const fallback = out.find((item) => item.edge.when === undefined);
  const candidates = [...matching, ...(fallback ? [fallback] : [])];
  if (!candidates.length) throw new RouteFailure("no_matching_edge", `no condition matched and there is no fallback edge`);
  let exhausted: string | null = null;
  for (const candidate of candidates) {
    const target = candidate.edge.to;
    const targetNode = c.nodes.get(target);
    if (targetNode && targetNode.type !== "join" && targetNode.maxVisits !== undefined && visitsOf(engine, run.id, target, step.scope) >= targetNode.maxVisits) {
      exhausted = exhausted ?? target;
      engine.journal.event(run.id, step.step_key, "edge_skipped", null, null, `${target} reached maxVisits ${targetNode.maxVisits}`);
      continue;
    }
    deliver(engine, run, c, step, candidate.edge, candidate.index, { scope: step.scope, fromScope: step.scope, suffix: "" });
    return;
  }
  throw new RouteFailure(`guard:maxVisits`, `"${exhausted}" has used its visits`);
}

/** The list a for_each walks: a reference (with an optional `where`), a literal list, or a list picked by an input or the mode. */
export function forEachItems(engine: WorkflowEngine, run: RunRow, step: StepRow, node: Extract<WorkflowNode, { type: "parallel" }>): unknown[] {
  const source = node.for_each;
  const scope = env(engine, run, step);
  let items: unknown;
  if (Array.isArray(source)) items = source;
  else if (typeof source === "string") {
    const [reference, where] = source.split(/\s+where\s+/, 2) as [string, string | undefined];
    const found = scope.read(refOf(reference.trim()));
    if (!found.ran) throw new RouteFailure("foreach_missing", `"${reference.trim()}" has no value`);
    items = found.value;
    if (where !== undefined && Array.isArray(items)) {
      const expr = parseExpr(where, { itemScope: true });
      items = items.filter((item, index) => evalCondition(expr, env(engine, run, step, { value: item, index }), `${node.id} where`));
    }
  } else if (source && typeof source === "object") {
    const table = source as { by: string } & Record<string, unknown>;
    const picked = scope.read(refOf(table.by));
    const key = String(picked.value);
    items = key in table ? table[key] : table.default;
  }
  if (!Array.isArray(items)) throw new RouteFailure("foreach_not_array", `for_each of "${node.id}" is not a list`);
  if (node.batch_size && node.batch_size > 1) {
    const chunks: unknown[][] = [];
    for (let at = 0; at < items.length; at += node.batch_size) chunks.push(items.slice(at, at + node.batch_size));
    return chunks;
  }
  return items;
}

/** Order `depends_on`: item `i` waits for the items whose `id` its `depends_on` names (an id outside the list is taken as done). A cycle fails the run. */
export function dependencies(node: Extract<WorkflowNode, { type: "parallel" }>, items: unknown[]): number[][] {
  const ids = items.map((item) => (typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string" ? (item as { id: string }).id : null));
  const after = items.map((item, index) => {
    const list = typeof item === "object" && item !== null ? (item as { depends_on?: unknown }).depends_on : undefined;
    return (Array.isArray(list) ? list : []).map((id) => ids.indexOf(String(id))).filter((at) => at >= 0 && at !== index);
  });
  const state = new Map<number, "open" | "done">();
  const visit = (at: number): void => {
    if (state.get(at) === "done") return;
    if (state.get(at) === "open") throw new RouteFailure("depends_cycle", `the items of "${node.id}" depend on each other in a cycle through ${ids[at] ?? at}`);
    state.set(at, "open");
    for (const next of after[at]!) visit(next);
    state.set(at, "done");
  };
  after.forEach((_unused, at) => visit(at));
  return after;
}

export function routeParallel(engine: WorkflowEngine, run: RunRow, c: Compiled, step: StepRow, node: Extract<WorkflowNode, { type: "parallel" }>): void {
  const out = c.out.get(node.id) ?? [];
  const limit = node.max_fan_out ?? c.wf.guards.maxFanOut;
  let branches: Array<{ edge: WorkflowEdge; index: number; item?: unknown; idx: number }>;
  if (node.for_each !== undefined) {
    const list = forEachItems(engine, run, step, node);
    let used = list;
    if (list.length > limit) {
      if (node.onOverflow === "truncate") { used = list.slice(0, limit); engine.journal.event(run.id, step.step_key, "fan_out_truncated", null, null, `${list.length} -> ${limit}`); }
      else throw new RouteFailure("guard:maxFanOut", `${list.length} items exceed the fan-out limit ${limit}`);
    }
    branches = used.map((item, idx) => ({ edge: out[0]!.edge, index: out[0]!.index, item, idx }));
  } else {
    if (out.length > limit) throw new RouteFailure("guard:maxFanOut", `${out.length} branches exceed the fan-out limit ${limit}`);
    branches = out.map((item, idx) => ({ edge: item.edge, index: item.index, idx }));
  }
  engine.journal.db.prepare("UPDATE lane_pilot_wf_step SET fan_count=? WHERE run_id=? AND step_key=?").run(branches.length, run.id, step.step_key);
  const joinNode = c.joinOf.get(node.id)!;
  const after = node.order === "depends_on" ? dependencies(node, branches.map((branch) => branch.item)) : null;
  // The items are kept on the parallel step: a blocked branch names the dependency it waited for from them.
  engine.journal.db.prepare("UPDATE lane_pilot_wf_step SET input_json=? WHERE run_id=? AND step_key=?").run(JSON.stringify({ ...asObject(step.input_json), items: branches.map((branch) => branch.item ?? null) }), run.id, step.step_key);
  for (const branch of branches) {
    const scope = `${step.scope ? `${step.scope}/` : ""}${step.step_key}~${branch.idx}`;
    deliver(engine, run, c, step, branch.edge, branch.index, { scope, fromScope: step.scope, suffix: `~${branch.idx}`, item: branch.item, index: branch.item === undefined ? undefined : branch.idx, group: { key: step.step_key, branch: branch.idx },
      ...(after?.[branch.idx]?.length ? { after: after[branch.idx] } : {}) });
  }
  if (branches.length === 0) tryJoin(engine, run, c, step.step_key, joinNode, step.scope);
}

/** Hands the data of an edge to its target: the exit, a join arrival, or a new step. */
export function deliver(engine: WorkflowEngine, run: RunRow, c: Compiled, from: StepRow | null, edge: WorkflowEdge, edgeIndex: number,
  where: { scope: string; fromScope: string; suffix: string; item?: unknown; index?: number; group?: { key: string; branch: number }; after?: number[] }): void {
  const j = engine.journal;
  const data = mapWith(engine, run, c, from, edge);
  if (edge.to === END) {
    if (where.scope !== "") throw new RouteFailure("branch_reached_end", "a branch reached the exit without its join");
    j.db.prepare("UPDATE lane_pilot_wf_run SET output_json=?, updated_at=? WHERE id=?").run(JSON.stringify(data), engine.now(), run.id);
    j.event(run.id, from?.step_key ?? null, "exit", null, null);
    return;
  }
  const target = c.nodes.get(edge.to)!;
  if (target.type === "join") {
    const group = where.group ?? (() => {
      const last = from?.scope.split("/").pop() ?? "";
      const at = last.lastIndexOf("~");
      return at < 0 ? null : { key: last.slice(0, at), branch: Number(last.slice(at + 1)) };
    })();
    if (!group) throw new RouteFailure("join_outside_branch", `join "${target.id}" was reached outside its parallel branches`);
    const parallelStep = j.getStep(run.id, group.key);
    if (!parallelStep || parallelStep.node_id !== target.parallel) throw new RouteFailure("join_outside_branch", `join "${target.id}" belongs to "${target.parallel}"`);
    j.db.prepare("INSERT OR IGNORE INTO lane_pilot_wf_arrival(run_id,group_key,branch,from_step,data_json,at) VALUES (?,?,?,?,?,?)")
      .run(run.id, group.key, group.branch, from?.step_key ?? group.key, JSON.stringify(data), engine.now());
    tryJoin(engine, run, c, group.key, target, parallelStep.scope);
    return;
  }
  const total = (j.db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_wf_step WHERE run_id=?").get(run.id) as { n: number }).n;
  if (total >= c.wf.guards.maxSteps) throw new RouteFailure("guard:maxSteps", `the run reached ${c.wf.guards.maxSteps} steps`);
  const visit = visitsOf(engine, run.id, target.id, where.scope) + 1;
  const input: StepInput = {
    with: data,
    via: { mode: edge.pass, fromStep: from?.step_key ?? null,
      ...(edge.pass !== "artifact" || from?.receipt_json ? { fromThreadId: sessionThread(engine, run, from, target.id, edge.pass, where.scope) } : {}),
      ...(from?.output_json ? { handoff: (asObject(from.output_json).handoff as string | undefined) ?? null } : {}) },
  };
  const inherited = from && from.scope === where.scope ? asObject(from.input_json) : {};
  const item = where.item !== undefined ? where.item : inherited.item;
  const index = where.item !== undefined ? where.index : (inherited.index as number | undefined);
  if (item !== undefined) input.item = item;
  if (index !== undefined) input.index = index;
  if (where.after?.length && where.group) { input.after = where.after; input.group = where.group.key; }
  const stepKey = `${target.id}#${visit}${where.scope ? `@${stableId(where.scope).slice(0, 6)}` : ""}`;
  const origin = stableId(from?.step_key ?? "entry", edgeIndex, where.suffix);
  const result = j.db.prepare(`INSERT OR IGNORE INTO lane_pilot_wf_step(run_id,step_key,origin,node_id,visit,scope,parent_key,edge_index,state,input_json,updated_at) VALUES (?,?,?,?,?,?,?,?,'pending',?,?)`)
    .run(run.id, stepKey, origin, target.id, visit, where.scope, from?.step_key ?? null, edgeIndex, JSON.stringify(input), engine.now());
  if (result.changes > 0) j.event(run.id, stepKey, "step", null, "pending", from ? `from ${from.step_key}` : "entry");
}

/**
 * The thread a step goes on in (same-session) or reads (read-prior-session): for a loop back to an agent, that agent's own earlier
 * session; else the source step's thread, and when the source is not an agent (a lint, a check) the latest helper thread of the branch.
 */
export function sessionThread(engine: WorkflowEngine, run: RunRow, from: StepRow | null, targetId: string, pass: PassMode, scope: string): string | null {
  const threadOf = (row: { receipt_json: string | null } | undefined | null): string | null => {
    if (!row?.receipt_json) return null;
    const id = (JSON.parse(row.receipt_json) as { threadId?: string | null }).threadId;
    return typeof id === "string" && id ? id : null;
  };
  const latest = (node?: string) => engine.journal.db.prepare(`SELECT receipt_json FROM lane_pilot_wf_step WHERE run_id=? AND scope=?${node ? " AND node_id=?" : ""} AND receipt_json LIKE '%"threadId":"%' ORDER BY rowid DESC LIMIT 1`)
    .get(...(node ? [run.id, scope, node] : [run.id, scope])) as { receipt_json: string | null } | undefined;
  if (pass === "same-session") { const own = threadOf(latest(targetId)); if (own) return own; }
  return threadOf(from) ?? (pass === "artifact" ? null : threadOf(latest()));
}

export function tryJoin(engine: WorkflowEngine, run: RunRow, c: Compiled, groupKey: string, join: Extract<WorkflowNode, { type: "join" }>, parentScope: string): void {
  const j = engine.journal;
  const parallelStep = j.getStep(run.id, groupKey)!;
  if (parallelStep.fan_count === null) return;
  const arrivals = j.db.prepare("SELECT branch, data_json FROM lane_pilot_wf_arrival WHERE run_id=? AND group_key=? ORDER BY branch").all(run.id, groupKey) as Array<{ branch: number; data_json: string }>;
  if (arrivals.length < parallelStep.fan_count) return;
  const parsed = arrivals.map((row) => ({ branch: row.branch, data: JSON.parse(row.data_json) as Record<string, unknown> }));
  const items = (asObject(parallelStep.input_json) as { items?: unknown[] }).items ?? [];
  // `results`: the branches that finished, in branch order. `failed`: the ones a tolerant join lets pass, with their item and error.
  const results = parsed.filter((row) => row.data.$failed === undefined).map((row) => row.data);
  const failed = parsed.filter((row) => row.data.$failed !== undefined).map((row) => ({ branch: row.branch, item: items[row.branch] ?? null, error: String(row.data.$failed), blocked: row.data.$blocked === true }));
  const rows = parsed.map((row) => ({ branch: row.branch, item: items[row.branch] ?? null, ok: row.data.$failed === undefined, ...(row.data.$failed === undefined ? { data: row.data } : { error: String(row.data.$failed), blocked: row.data.$blocked === true }) }));
  const visit = visitsOf(engine, run.id, join.id, parentScope) + 1;
  const stepKey = `${join.id}#${visit}${parentScope ? `@${stableId(parentScope).slice(0, 6)}` : ""}`;
  const input: StepInput = { with: { results, failed, rows, items }, via: { mode: "artifact", fromStep: groupKey } };
  const result = j.db.prepare(`INSERT OR IGNORE INTO lane_pilot_wf_step(run_id,step_key,origin,node_id,visit,scope,parent_key,edge_index,state,input_json,updated_at) VALUES (?,?,?,?,?,?,?,?,'pending',?,?)`)
    .run(run.id, stepKey, stableId("join", groupKey, join.id), join.id, visit, parentScope, groupKey, null, JSON.stringify(input), engine.now());
  if (result.changes > 0) j.event(run.id, stepKey, "step", null, "pending", `join of ${groupKey}`);
}

