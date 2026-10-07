import { PURE_ACTION_KEYS, pureActionExecutor } from "../../src/workflow/actions";
import { writeFileSync } from "node:fs";
import { BUILTIN_SOURCES } from "../../src/workflow/builtin";
import type { NodeExecutor, RunSummary, StepContext } from "../../src/workflow/engine";
import { executorKey, lowerWorkflow, outputFields } from "../../src/workflow/lower";
import { registerReducers } from "../../src/workflow/reducers";
import type { Field, QualityMode, Workflow } from "../../src/workflow/schema";
import { loadWorkflowStore } from "../../src/workflow/store";
import type { WorkflowStore } from "../../src/workflow/store";
import { engineOn, journalDb, rows } from "./engine-helpers";

/**
 * The test case of a built-in chain: the whole graph runs on the real engine with the real reducers, and every node that
 * would call a model, a tool or the outside world answers from a stub. A stub is what the node returns (a partial object over
 * schema-made defaults), a list (one answer per visit, the last one repeats) or a function. The path of the run (nodes that ran
 * or were skipped, in order) and the outputs are what a test case asserts.
 */
type Row = Record<string, unknown>;
export type Stub = Row | Row[] | ((ctx: StepContext) => Row);
export type Sim = {
  input: Row;
  mode?: QualityMode;
  /** By node id (`score:child` for the child of a fan-out), by the id of a workflow a subworkflow node calls, by the action key (`bb.tasks.get`) or by node type (`lp-task`). */
  stubs?: Record<string, Stub>;
  /** Answers of `human` nodes by node id: the output fields, or a list of them, one per visit. */
  humans?: Record<string, Row | Row[]>;
  /** What the run must end as; `succeeded` by default. */
  status?: RunSummary["status"];
};

let storePromise: Promise<WorkflowStore> | null = null;
export const chainStore = (): Promise<WorkflowStore> => (storePromise ??= loadWorkflowStore({ builtin: BUILTIN_SOURCES }));

const FALSE_BY_NAME = /(^|_)(stalled|warn|has_ui|blocked|failed|thin|timeout|drift|error|errors|missing|dirty|unmet|needs|skipped|breaking|regression|rejected|duplicate)(_|$)/;
const defaultValue = (field: Field, node: string): unknown => {
  switch (field.type) {
    case "string": return field.default ?? "stub";
    case "number": return field.default ?? (/confidence|score|percent|coverage/.test(field.name) ? 90 : /_count$|^count$|attempts|^n$/.test(field.name) ? 1 : 1);
    case "boolean": return field.default ?? !FALSE_BY_NAME.test(field.name);
    case "enum": return field.default ?? field.values![0];
    case "array": return field.default ?? [];
    case "object": return field.default ?? {};
    default: return field.default ?? {};
  }
};

export type Called = { node: string; input: Row; visit: number };

export async function runSim(workflowId: string, sim: Sim) {
  const store = await chainStore();
  const workflow = store.get(workflowId)!.workflow;
  const db = journalDb();
  const calls: Called[] = [];
  const visits = new Map<string, number>();
  const executors = new Map<string, NodeExecutor>();

  const pick = (key: string, stub: Stub | undefined, ctx: StepContext): Row => {
    if (stub === undefined) return {};
    if (typeof stub === "function") return stub(ctx);
    if (Array.isArray(stub)) return stub[Math.min(visits.get(key)! - 1, stub.length - 1)] ?? {};
    return stub;
  };
  const answer = (ctx: StepContext, stub: Stub | undefined, fields: Field[] | "unknown"): Row => {
    const key = ctx.nodeId;
    visits.set(key, (visits.get(key) ?? 0) + 1);
    calls.push({ node: key, input: ctx.input.with, visit: visits.get(key)! });
    const given = pick(key, stub, ctx);
    const base = fields === "unknown" ? {} : Object.fromEntries(fields.map((field) => [field.name, defaultValue(field, key)]));
    return { ...base, ...(ctx.node.type === "agent" ? { handoff: `${key} done` } : {}), ...given };
  };
  const stubOf = (ctx: StepContext): Stub | undefined => sim.stubs?.[ctx.nodeId] ?? (ctx.node.type === "subworkflow" ? sim.stubs?.[ctx.node.workflow] : undefined)
    ?? (ctx.nodeId.endsWith(":child") ? sim.stubs?.[ctx.nodeId.slice(0, -":child".length)] : undefined) ?? (ctx.node.type === "action" ? sim.stubs?.[ctx.node.action ?? ""] : undefined) ?? sim.stubs?.[ctx.node.type];

  const model: NodeExecutor = { reentrant: true, run: async (ctx) => ({ output: answer(ctx, stubOf(ctx), outputFields(ctx.workflow, ctx.node)) }) };

  // Every executor key any chain uses: the agent, the code task, the actions of the catalog and the fragments' joins.
  const every = new Set<string>();
  const collect = (wf: Workflow) => { for (const node of lowerWorkflow(wf, store.resolve).nodes) if (node.type !== "note") { const key = executorKey(node); if (key && !key.startsWith("builtin:") && !key.startsWith("reduce.")) every.add(key); } };
  for (const item of store.list()) collect(item.workflow);

  const engine = engineOn(db, {}, { resolveWorkflow: store.resolve });
  for (const key of every) executors.set(key, model);
  for (const [key, executor] of executors) engine.register(key, executor);
  registerReducers(engine);
  // The actions that are code run for real, unless the sim stubs that node.
  for (const key of PURE_ACTION_KEYS) {
    const real = pureActionExecutor(key);
    engine.register(key, { reentrant: true, run: async (ctx) => (stubOf(ctx) !== undefined ? model.run(ctx) : real.run(ctx)) });
  }

  // A human answers at once from the sim (the waiting itself is the engine's, tested elsewhere): the first answer kind by default.
  engine.register("builtin:human", { reentrant: true, run: async (ctx) => {
    const node = ctx.node;
    const fields = outputFields(ctx.workflow, node);
    const given = sim.humans?.[ctx.nodeId];
    visits.set(ctx.nodeId, (visits.get(ctx.nodeId) ?? 0) + 1);
    calls.push({ node: ctx.nodeId, input: ctx.input.with, visit: visits.get(ctx.nodeId)! });
    const chosen = Array.isArray(given) ? given[Math.min(visits.get(ctx.nodeId)! - 1, given.length - 1)] : given;
    const base = fields === "unknown" ? {} : Object.fromEntries(fields.map((field) => [field.name, field.name === "answer" ? "" : defaultValue(field, ctx.nodeId)]));
    return { output: { ...base, ...(chosen ?? {}) } };
  } });

  // A subworkflow whose id is stubbed answers from the stub instead of running the fragment; any other runs for real.
  const real = (engine as unknown as { executors: Map<string, NodeExecutor> }).executors.get("builtin:subworkflow")!;
  engine.register("builtin:subworkflow", { ...real, run: async (ctx) => {
    const node = ctx.node as Extract<typeof ctx.node, { type: "subworkflow" }>;
    if (sim.stubs && (node.id in sim.stubs || node.workflow in sim.stubs)) {
      const stub = (node.id in sim.stubs ? sim.stubs[node.id] : sim.stubs[node.workflow]) as Stub;
      return { output: answer(ctx, stub, outputFields(ctx.workflow, ctx.node)) };
    }
    return real.run(ctx);
  } });

  const started = engine.start({ workflow, inputs: sim.input, mode: sim.mode });
  const summary = await started.done;
  const steps = rows<{ node_id: string; state: string; step_key: string }>(db, "SELECT node_id, state, step_key FROM lane_pilot_wf_step WHERE run_id=? ORDER BY rowid", summary.runId);
  const path = steps.filter((step) => step.state === "succeeded" || step.state === "skipped").map((step) => step.node_id).filter((id) => !id.endsWith(":fan") && !id.endsWith(":child"));
  const skipped = steps.filter((step) => step.state === "skipped").map((step) => step.node_id);
  // SIM_DEBUG=1: every run leaves its summary, path and steps in /tmp/w3/dbg-<workflow>.json (the last one wins).
  if (process.env.SIM_DEBUG) writeFileSync(`/tmp/w3/dbg-${workflowId}.json`, JSON.stringify({ summary, path, steps: steps.map((step) => `${step.step_key}:${step.state}`) }, null, 1));
  return { summary, path, skipped, calls, db, engine, workflow, steps, called: (node: string) => calls.filter((call) => call.node === node) };
}

export type SimResult = Awaited<ReturnType<typeof runSim>>;
