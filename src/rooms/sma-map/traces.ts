// Node-level traces: what in the hub's plugin database (or a drill receipt) shows that ONE map node really fired with
// the right result. A source is plain data — validated by tests/sma-evidence.test.ts and run on the real schema by
// tests/sma-traces.test.ts — and yields how many times it fired in the window and the newest time. The group-level
// SMA_LIVE (live.ts) stays a separate, weaker signal (`groupObserved`) and never counts as node evidence.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Words = string | readonly string[];

export type TraceSource =
  | { kind: "gate"; gate: string; status?: Words }
  | { kind: "stage"; stage: string; state?: Words }
  | { kind: "receipt"; stage: string; state?: Words }
  | { kind: "transition"; from?: Words; to?: Words; reason?: string }
  | { kind: "taskField"; field: string; reason?: string }
  | { kind: "wfRun"; workflow: Words; status?: Words }
  | { kind: "wfStep"; workflow: string; node: Words; state?: Words }
  | { kind: "part"; section?: Words; partKind?: Words }
  | { kind: "schedule"; name: string; status?: Words }
  | { kind: "setting"; key: string }
  | { kind: "rows"; table: string; clock: string; where?: string }
  | { kind: "kv"; key: string }
  | { kind: "rpc"; method: string }
  | { kind: "drill"; scene: string }
  | { kind: "outside"; where: string };

// ---- constructors (what an evidence line writes) ----
/** A gate event (lane_pilot_gate_event) of `gate`, optionally with these statuses (passed, rejected, failed, skipped). */
export const gate = (name: string, status?: Words): TraceSource => ({ kind: "gate", gate: name, ...(status ? { status } : {}) });
/** A stage event (lane_pilot_stage_event) of `stage` in these states (passed, failed, blocked, skipped, …). */
export const stage = (name: string, state?: Words): TraceSource => ({ kind: "stage", stage: name, ...(state ? { state } : {}) });
/** A stage receipt (lane_pilot_stage_receipt) of `stage` in these states (accepted, pass, rework, block, …). */
export const receipt = (name: string, state?: Words): TraceSource => ({ kind: "receipt", stage: name, ...(state ? { state } : {}) });
/** An attempt transition (lane_pilot_attempt_transition) from → to, optionally with a reason substring. */
export const transition = (move: { from?: Words; to?: Words; reason?: string }): TraceSource => ({ kind: "transition", ...move });
/** A task field change (lane_pilot_task_transition), optionally with a reason substring. */
export const taskField = (field: string, reason?: string): TraceSource => ({ kind: "taskField", field, ...(reason ? { reason } : {}) });
/** A workflow run (lane_pilot_wf_run) of these workflow ids, optionally ending in these statuses. */
export const wfRun = (workflow: Words, status?: Words): TraceSource => ({ kind: "wfRun", workflow, ...(status ? { status } : {}) });
/** A workflow step (lane_pilot_wf_step) of node(s) `node` in workflow `workflow`, optionally in these states. */
export const wfStep = (workflow: string, node: Words, state?: Words): TraceSource => ({ kind: "wfStep", workflow, node, ...(state ? { state } : {}) });
/** A phase book part (lane_pilot_phase_part) of these sections and/or kinds. */
export const part = (where: { section?: Words; kind?: Words }): TraceSource => ({ kind: "part", ...(where.section ? { section: where.section } : {}), ...(where.kind ? { partKind: where.kind } : {}) });
/** A schedule run (lane_pilot_schedule_run) of the schedule named `name` (its name or kind), optionally in these statuses. */
export const schedule = (name: string, status?: Words): TraceSource => ({ kind: "schedule", name, ...(status ? { status } : {}) });
/** A settings row (lane_pilot_project_settings) of `key` written in the window. */
export const settingRow = (key: string): TraceSource => ({ kind: "setting", key });
/** Any other lane_pilot_* table: rows whose `clock` (ms) is in the window and match `where`. The last resort. */
export const rows = (table: string, clock: string, where?: string): TraceSource => ({ kind: "rows", table, clock, ...(where ? { where } : {}) });
/** A plugin KV key (BB core storage, not in the plugin database): judged only where a KV reader is given. */
export const kv = (key: string): TraceSource => ({ kind: "kv", key });
/** An RPC / door call (BB rpc timing log): judged only where an RPC log reader is given. */
export const rpc = (method: string): TraceSource => ({ kind: "rpc", method });
/** A drill scene that passed AND whose receipt entry lists THIS node in `proved` with ok true (.agents/runs/drills/*.json).
 * The node id is the evidence registry key; a scene that passed without proving the node does not count (a scene-level claim is hollow). */
export const drill = (scene: string): TraceSource => ({ kind: "drill", scene });
/** Not judged here and never counted: the trace lives elsewhere (`where` says where). */
export const outside = (where: string): TraceSource => ({ kind: "outside", where });

const list = (words: Words) => (typeof words === "string" ? [words] : [...words]);
const quote = (word: string) => `'${word.replace(/'/g, "''")}'`;
const isIn = (column: string, words: Words | undefined) => (words === undefined ? "1=1" : `${column} IN (${list(words).map(quote).join(",")})`);
const like = (column: string, text: string | undefined) => (text === undefined ? "1=1" : `${column} LIKE ${quote(`%${text}%`)}`);
const P = "lane_pilot_";
const count = (table: string, clock: string, where: string) => `SELECT COUNT(*) AS n, MAX(${clock}) AS last FROM ${P}${table} WHERE ${clock} >= :since AND (${where})`;

/** The SQL a source runs (`:since` is the window start in ms), or null for a source the database cannot answer. */
export function traceSql(source: TraceSource): string | null {
  switch (source.kind) {
    case "gate": return count("gate_event", "occurred_at", `gate = ${quote(source.gate)} AND ${isIn("status", source.status)}`);
    case "stage": return count("stage_event", "occurred_at", `stage_id = ${quote(source.stage)} AND ${isIn("state", source.state)}`);
    case "receipt": return count("stage_receipt", "updated_at", `stage_id = ${quote(source.stage)} AND ${source.state === undefined ? "1=1" : `(${isIn("state", source.state)} OR ${isIn("json_extract(result_json, '$.status')", source.state)} OR ${isIn("json_extract(result_json, '$.verdict')", source.state)})`}`);
    case "transition": return count("attempt_transition", "at", `${isIn("from_state", source.from)} AND ${isIn("to_state", source.to)} AND ${like("reason", source.reason)}`);
    case "taskField": return count("task_transition", "at", `field = ${quote(source.field)} AND ${like("reason", source.reason)}`);
    case "wfRun": return count("wf_run", "created_at", `${isIn("workflow_id", source.workflow)} AND ${isIn("status", source.status)}`);
    case "wfStep": return `SELECT COUNT(*) AS n, MAX(s.started_at) AS last FROM ${P}wf_step s JOIN ${P}wf_run r ON r.id = s.run_id WHERE s.started_at >= :since AND r.workflow_id = ${quote(source.workflow)} AND ${isIn("s.node_id", source.node)} AND ${source.state === undefined ? "s.state <> 'skipped'" : isIn("s.state", source.state)}`;
    case "part": return count("phase_part", "at", `${isIn("section", source.section)} AND ${isIn("kind", source.partKind)}`);
    case "schedule": return `SELECT COUNT(*) AS n, MAX(sr.started_at) AS last FROM ${P}schedule_run sr JOIN ${P}schedule s ON s.id = sr.schedule_id WHERE sr.started_at >= :since AND (s.name = ${quote(source.name)} OR s.kind = ${quote(source.name)}) AND ${isIn("sr.status", source.status)}`;
    case "setting": return count("project_settings", "updated_at", `key = ${quote(source.key)}`);
    case "rows": return `SELECT COUNT(*) AS n, MAX(${source.clock}) AS last FROM ${source.table} WHERE ${source.clock} >= :since AND (${source.where ?? "1=1"})`;
    default: return null;
  }
}

/** What a source says over the window: `judged` false when it cannot be answered here (outside, KV, RPC, no drills). */
export type TraceReading = { n: number; last: number | null; judged: boolean; error?: string };

type Db = { prepare(sql: string): { get(...args: unknown[]): unknown } };

/** A drill receipt as lp-drill writes it: when it finished, which scenes passed, and which node each passed scene proved
 * (`proved` entries of the scene with ok true: the scene itself asserted the node's expected result and wrote it down). */
export type DrillReceipt = { finishedAt: number; commit: string | null; passed: readonly string[]; proved: ReadonlyArray<{ scene: string; node: string }> };

/** The drill receipts in `dir` (lp-drill.py's .agents/runs/drills/*.json); [] when the folder is not on this machine. */
export function readDrills(dir: string | undefined): DrillReceipt[] | null {
  if (!dir || !existsSync(dir)) return null;
  const out: DrillReceipt[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const receipt = JSON.parse(readFileSync(join(dir, name), "utf8")) as { finishedAt?: number; commit?: string; scenarios?: Array<{ name?: string; result?: string; proved?: Array<{ node?: string; ok?: boolean }> }> };
      if (typeof receipt.finishedAt !== "number") continue;
      const passedScenes = (receipt.scenarios ?? []).filter((scene) => scene.result === "pass" && scene.name);
      out.push({
        finishedAt: receipt.finishedAt, commit: receipt.commit ?? null, passed: passedScenes.map((scene) => scene.name!),
        proved: passedScenes.flatMap((scene) => (Array.isArray(scene.proved) ? scene.proved : []).filter((item) => item?.ok === true && typeof item.node === "string").map((item) => ({ scene: scene.name!, node: item.node! }))),
      });
    } catch { /* a receipt being written */ }
  }
  return out;
}

export type TraceContext = { db?: Db; drills?: DrillReceipt[] | null; kv?: (key: string) => { n: number; last: number | null } | null; rpc?: (method: string) => { n: number; last: number | null } | null };

/** Reads one source over the window that starts at `since` (ms). `node` is the map node the source belongs to: a drill source counts only receipts that prove that node. */
export function readTrace(ctx: TraceContext, source: TraceSource, since: number, node?: string): TraceReading {
  if (source.kind === "outside") return { n: 0, last: null, judged: false };
  if (source.kind === "drill") {
    if (!ctx.drills) return { n: 0, last: null, judged: false };
    const hits = ctx.drills.filter((receipt) => receipt.finishedAt >= since && node !== undefined && receipt.proved.some((item) => item.scene === source.scene && item.node === node));
    return { n: hits.length, last: hits.length ? Math.max(...hits.map((hit) => hit.finishedAt)) : null, judged: true };
  }
  if (source.kind === "kv" || source.kind === "rpc") {
    const read = source.kind === "kv" ? ctx.kv?.(source.key) : ctx.rpc?.(source.method);
    return read ? { ...read, judged: true } : { n: 0, last: null, judged: false };
  }
  const sql = traceSql(source);
  if (!sql || !ctx.db) return { n: 0, last: null, judged: false };
  try {
    const row = ctx.db.prepare(sql.replace(/:since/g, String(Math.floor(since)))).get() as { n?: number; last?: number | null } | undefined;
    return { n: Number(row?.n ?? 0), last: row?.last ?? null, judged: true };
  } catch (cause) {
    return { n: 0, last: null, judged: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** A node's sources together: fired = the sum, newest = the newest; judged when any source could be answered. */
export function readTraces(ctx: TraceContext, sources: readonly TraceSource[], since: number, node?: string): TraceReading & { readings: TraceReading[] } {
  const readings = sources.map((source) => readTrace(ctx, source, since, node));
  const judged = readings.filter((reading) => reading.judged);
  const lasts = judged.map((reading) => reading.last).filter((last): last is number => typeof last === "number");
  const error = readings.find((reading) => reading.error)?.error;
  return { n: judged.reduce((sum, reading) => sum + reading.n, 0), last: lasts.length ? Math.max(...lasts) : null, judged: judged.length > 0, readings, ...(error ? { error } : {}) };
}

/** A one-line name of a source for reports. */
export function traceLabel(source: TraceSource): string {
  const { kind, ...rest } = source;
  return `${kind}(${Object.values(rest).map((value) => (Array.isArray(value) ? value.join("|") : String(value))).join(", ")})`;
}
