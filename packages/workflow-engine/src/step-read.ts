import { MissingValueError, refOf } from "./expr";
import type { EvalEnv, Ref } from "./expr";
import type { RunRow, StepRow } from "./journal";
import { outputFields } from "./lower";
import type { WorkflowEdge } from "./schema";
import { slugOf, valueAtPath } from "./values";
import type { Compiled } from "./compiled";
import { RouteFailure } from "./engine-errors";
import type { WorkflowEngine } from "./engine";

export const scopeChain = (scope: string): string[] => {
  const parts = scope ? scope.split("/") : [];
  return [...parts.map((_part, index) => parts.slice(0, parts.length - index).join("/")), ""];
};
export const asObject = (text: string | null): Record<string, unknown> => (text ? JSON.parse(text) as Record<string, unknown> : {});
export const STARTED = ["succeeded", "failed", "running", "waiting", "interrupted"];
/** The latest settled step of `node` visible from `scopes`; `beforeRowid` bounds the read to steps that already existed. */
const latestNodeStep = (engine: WorkflowEngine, run: RunRow, scopes: string[], node: string | undefined, beforeRowid?: number): StepRow | undefined =>
  engine.journal.db.prepare(`SELECT * FROM lane_pilot_wf_step WHERE run_id=? AND node_id=? AND state IN ('succeeded','skipped') AND scope IN (${scopes.map(() => "?").join(",")})${beforeRowid === undefined ? "" : " AND rowid<?"} ORDER BY rowid DESC LIMIT 1`)
    .get(...(beforeRowid === undefined ? [run.id, node, ...scopes] : [run.id, node, ...scopes, beforeRowid])) as StepRow | undefined;
/** In a value position (`emit.map`, `skip_out`, a node's `with`) a node that has not run gives nothing, where a condition on it would fail the run. */
export const lenient = (env: EvalEnv): EvalEnv => ({ ...env, read: (ref) => { const found = env.read(ref); return found.ran ? found : { ran: true, value: undefined }; } });

export function mergedCommits(engine: WorkflowEngine, runId: string): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    const rows = engine.journal.db.prepare("SELECT output_json FROM lane_pilot_wf_step WHERE run_id=? AND state='succeeded' AND output_json LIKE '%merged_commits%' ORDER BY rowid").all(id) as Array<{ output_json: string }>;
    for (const row of rows) { const value = asObject(row.output_json).merged_commits; if (Array.isArray(value)) for (const commit of value) if (typeof commit === "string" && !out.includes(commit)) out.push(commit); }
    for (const child of engine.journal.db.prepare("SELECT id FROM lane_pilot_wf_run WHERE parent_run_id=?").all(id) as Array<{ id: string }>) walk(child.id);
  };
  walk(runId);
  return out;
}

/** The values a step's expressions see: inputs, mode, context, the item of its branch, and the latest output of each node. */
export function env(engine: WorkflowEngine, run: RunRow, step: StepRow | null, item?: { value: unknown; index?: number }): EvalEnv {
  const scopes = scopeChain(step?.scope ?? "");
  const stepInput = step ? asObject(step.input_json) : {};
  return {
    read: (ref: Ref) => {
      switch (ref.kind) {
        case "input": return { ran: true, value: valueAtPath(asObject(run.inputs_json), ref.path) };
        case "mode": return { ran: true, value: run.mode };
        case "var": return { ran: true, value: ref.path[0] === "date" ? new Date(engine.now()).toISOString().slice(0, 10) : ref.path[0] === "slug" ? slugOf(asObject(run.inputs_json)) : run.id };
        case "ctx": {
          const name = ref.path[0];
          if (name === "answers") {
            const node = ref.path[1];
            if (!node || engine.compiled(run).nodes.get(node)?.type !== "human"
              || (ref.path.length !== 2 && !(ref.path.length === 3 && ref.path[2] === "length"))) {
              throw new MissingValueError("answer_history_ref", "ctx.answers requires a named human node, optionally followed by .length");
            }
            // Current settled rows, not an immutable history: rerun may replace or remove them.
            const rows = engine.journal.db.prepare(`SELECT step_key, scope, visit, output_json FROM lane_pilot_wf_step WHERE run_id=? AND node_id=? AND state='succeeded' AND scope IN (${scopes.map(() => "?").join(",")}) ORDER BY rowid`)
              .all(run.id, node, ...scopes) as Array<Pick<StepRow, "step_key" | "scope" | "visit" | "output_json">>;
            const answers = rows.map(({ step_key, scope, visit, output_json }) => ({ step_key, scope, visit, output: asObject(output_json) }));
            return { ran: true, value: ref.path[2] === "length" ? answers.length : answers };
          }
          const value = name === "run_id" ? run.id : name === "goal" ? asObject(run.inputs_json).goal : name === "merged_commits" ? mergedCommits(engine, run.id) : undefined;
          return { ran: true, value: valueAtPath(value, ref.path.slice(1)) };
        }
        case "item": {
          const base = item ? item.value : stepInput.item;
          return { ran: item !== undefined || stepInput.item !== undefined, value: valueAtPath(base, ref.path) };
        }
        case "index": return { ran: true, value: item ? item.index : stepInput.index };
        default: {
          const row = latestNodeStep(engine, run, scopes, ref.node);
          if (!row) return { ran: false, value: undefined };
          const output = asObject(row.output_json);
          return { ran: true, value: ref.path.length ? valueAtPath(output, ref.path) : output };
        }
      }
    },
    visits: (node) => (engine.journal.db.prepare(`SELECT COUNT(*) AS n FROM lane_pilot_wf_step WHERE run_id=? AND node_id=? AND state IN (${STARTED.map(() => "?").join(",")}) AND scope IN (${scopes.map(() => "?").join(",")})`)
      .get(run.id, node, ...STARTED, ...scopes) as { n: number }).n,
  };
}


export function refRequired(c: Compiled, text: string): boolean {
  const ref = refOf(text);
  if (ref.kind !== "node" && ref.kind !== "input") return false;
  const fields = ref.kind === "input" ? c.wf.inputs : (c.nodes.get(ref.node!) ? outputFields(c.wf, c.nodes.get(ref.node!)) : []);
  if (fields === "unknown") return false;
  const field = fields.find((candidate) => candidate.name === ref.path[0]);
  return Boolean(field?.required) && ref.path.length === 1;
}

/**
 * The step a node reference resolved to for a consumer delivered as `consumerKey`: the latest settled producer in the
 * delivering step's scope chain among the steps that already existed when the consumer was inserted (rowid ceiling).
 * Read-side provenance for actions that must know WHERE the referenced value was produced; `env` itself stays
 * ceiling-free. Undefined for non-node refs, a missing consumer row, or no matching producer. `ceilingBound` false
 * drops the rowid bound for execution-time reads (a `{{ref}}` template resolves the latest value, like `env`).
 */
export function nodeRefStep(engine: WorkflowEngine, run: RunRow, from: StepRow | null, consumerKey: string, ref: Ref, ceilingBound = true): { step: StepRow; value: unknown } | undefined {
  if (ref.kind !== "node" || !ref.node) return undefined;
  const ceiling = ceilingBound
    ? (engine.journal.db.prepare("SELECT rowid AS r FROM lane_pilot_wf_step WHERE run_id=? AND step_key=?").get(run.id, consumerKey) as { r: number } | undefined)?.r
    : undefined;
  if (ceilingBound && ceiling === undefined) return undefined;
  const step = latestNodeStep(engine, run, scopeChain(from?.scope ?? ""), ref.node, ceiling);
  if (!step) return undefined;
  const output = asObject(step.output_json);
  return { step, value: ref.path.length ? valueAtPath(output, ref.path) : output };
}

export function mapWith(engine: WorkflowEngine, run: RunRow, c: Compiled, from: StepRow | null, edge: WorkflowEdge): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [name, text] of Object.entries(edge.with ?? {})) {
    const ref = refOf(text);
    const found = env(engine, run, from).read(ref);
    if (!found.ran || found.value === undefined || found.value === null) {
      if (refRequired(c, text)) throw new RouteFailure("mapping_field_missing", `"${text}" has no value for "${name}" on the edge ${edge.from} -> ${edge.to}`);
      continue;
    }
    data[name] = found.value;
  }
  return data;
}
