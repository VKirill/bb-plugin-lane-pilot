import { resolveRoleModel } from "@lane-pilot/models";
import { ERRAND_KINDS, ERRAND_KIND_ID, errandRoleFor, type ErrandKind } from "../schedule";

/**
 * The «Errands» page (owner, 2026-11-01: «a tab where I see which errands the system has and can grow them»): the kinds with the model each
 * runs on and the period's counts, and the recent errand runs themselves. Everything is read from the workflow journal: an errand is a run
 * of the graph `errand` (src/rooms/qa/server/errand-graph.ts), its kind, model and source sit in `inputs_json`, its verdict in `output_json`,
 * its helper thread in the `errand.spawn` effect, its cost in the run's own columns. No table of its own: a new kind is a row in
 * src/rooms/schedule/errand-kinds.ts and shows here by itself.
 */
type Db = { prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown } };

export type ErrandOutcome = "running" | "done" | "blocked" | "failed" | "canceled";
/** What the code saw of a done (errandCheck): `unknown` for a run before CHECK lines, and for one that did not end in a report. */
export type ErrandVerifiedOutcome = "done_checked" | "done_unchecked" | "blocked" | "unknown";
export type ErrandKindOrNone = ErrandKind | "none";
export const ERRAND_KINDS_WITH_NONE: readonly ErrandKindOrNone[] = [...ERRAND_KINDS, "none"];
export type ErrandSource = { type: "schedule"; name: string } | { type: "pm"; threadId: string | null } | { type: "other" };
export type ErrandRow = {
  id: string; projectId: string | null; title: string; kind: ErrandKindOrNone; kindBy: string; providerId: string; model: string;
  outcome: ErrandOutcome; verified: ErrandVerifiedOutcome; reason: string; source: ErrandSource; threadId: string | null; tokens: number; costUsd: number; startedAt: number; endedAt: number | null;
};
export type KindSummary = {
  kind: ErrandKindOrNone; role: string; providerId: string; model: string; effort: string; source: string;
  runs: number; done: number; checked: number; blocked: number; failed: number; costUsd: number; jevWouldPick: number;
};

const DAY_MS = 86_400_000;
const parse = <T,>(text: string | null | undefined, fallback: T): T => { try { return text ? (JSON.parse(text) as T) : fallback; } catch { return fallback; } };

/** What an errand run came to, in the owner's five words; a helper the owner stopped is «canceled», not a failure (schedule-service.ts says the same). */
export function errandOutcome(status: string, output: { state?: unknown; reason?: unknown; verified?: unknown } | null, reason: string | null): { outcome: ErrandOutcome; reason: string; verified: ErrandVerifiedOutcome } {
  const verified: ErrandVerifiedOutcome = status === "succeeded" && (output?.verified === "done_checked" || output?.verified === "done_unchecked" || output?.verified === "blocked") ? output.verified : "unknown";
  if (status === "running" || status === "waiting") return { outcome: "running", reason: "", verified };
  const why = typeof output?.reason === "string" && output.reason ? output.reason : reason ?? "";
  if (status === "canceled") return { outcome: "canceled", reason: why, verified };
  if (status === "succeeded") {
    if (output?.state === "done") return { outcome: "done", reason: "", verified };
    return /cancel/iu.test(why) ? { outcome: "canceled", reason: why, verified } : { outcome: "blocked", reason: why, verified };
  }
  return { outcome: "failed", reason: why, verified };
}

/** The errand's name on the page: the title it was given, else the first line of the brief after a schedule's standing preamble. */
export function errandTitle(inputs: { title?: unknown; task?: unknown }): string {
  if (typeof inputs.title === "string" && inputs.title.trim()) return inputs.title.trim().slice(0, 120);
  const task = typeof inputs.task === "string" ? inputs.task : "";
  const line = task.split("\n").map((part) => part.trim()).find((part) => part && !/^This is a scheduled run of|^If the task needs a decision/u.test(part)) ?? "";
  return line.replace(/^Owner request \([^)]*\):\s*/u, "").replace(/^"|"$/gu, "").slice(0, 120) || "—";
}

const kindOf = (value: unknown): ErrandKindOrNone => (typeof value === "string" && (ERRAND_KINDS as readonly string[]).includes(value) ? (value as ErrandKind) : "none");

type RunRow = {
  id: string; project_id: string | null; status: string; reason: string | null; inputs_json: string; output_json: string | null;
  tokens_used: number; cost_micro_usd: number; created_at: number; updated_at: number; thread_id: string | null; pm_thread_id: string | null; schedule_name: string | null;
};

/** The errand runs of a period, newest first, with their kind, model, outcome, source, helper thread and cost. */
export function listErrands(db: Db, input: { days: number; kind?: string | undefined; projectId?: string | undefined; limit?: number | undefined }): ErrandRow[] {
  const since = Date.now() - input.days * DAY_MS;
  const kind = input.kind && input.kind !== "all" ? input.kind : null;
  const rows = db.prepare(`
    SELECT r.id, r.project_id, r.status, r.reason, r.inputs_json, r.output_json, r.tokens_used, r.cost_micro_usd, r.created_at, r.updated_at,
      (SELECT json_extract(e.result_json,'$.threadId') FROM lane_pilot_wf_effect e WHERE e.run_id=r.id AND e.kind='errand.spawn' AND e.state='done' LIMIT 1) AS thread_id,
      (SELECT x.pm_thread_id FROM lane_pilot_run x WHERE x.id=r.link_run_id) AS pm_thread_id,
      (SELECT s.name FROM lane_pilot_schedule s WHERE s.id=json_extract(r.inputs_json,'$.scheduleId')) AS schedule_name
    FROM lane_pilot_wf_run r
    WHERE r.workflow_id='errand' AND r.created_at>=?
      ${input.projectId ? "AND r.project_id=?" : ""}
      ${kind ? "AND COALESCE(NULLIF(json_extract(r.inputs_json,'$.kind'),''),'none')=?" : ""}
    ORDER BY r.created_at DESC LIMIT ?`).all(since, ...(input.projectId ? [input.projectId] : []), ...(kind ? [kind] : []), input.limit ?? 200) as RunRow[];
  return rows.map((row) => {
    const inputs = parse<Record<string, unknown>>(row.inputs_json, {});
    const output = parse<{ state?: unknown; reason?: unknown; verified?: unknown } | null>(row.output_json, null);
    const { outcome, reason, verified } = errandOutcome(row.status, output, row.reason);
    const scheduleId = typeof inputs.scheduleId === "string" ? inputs.scheduleId : "";
    const source: ErrandSource = scheduleId ? { type: "schedule", name: row.schedule_name ?? "" } : row.pm_thread_id ? { type: "pm", threadId: row.pm_thread_id } : { type: "other" };
    return {
      id: row.id, projectId: row.project_id, title: errandTitle(inputs), kind: kindOf(inputs.kind), kindBy: typeof inputs.kindBy === "string" ? inputs.kindBy : "",
      providerId: typeof inputs.providerId === "string" ? inputs.providerId : "", model: typeof inputs.model === "string" ? inputs.model : "",
      outcome, verified, reason: reason.slice(0, 300), source, threadId: row.thread_id, tokens: row.tokens_used, costUsd: row.cost_micro_usd / 1e6,
      startedAt: row.created_at, endedAt: outcome === "running" ? null : row.updated_at,
    };
  });
}

/** What Jev would have named in the period, by decision (`errand.kind` in shadow writes a receipt per classified brief and runs nothing). */
function jevShadowCounts(db: Db, since: number): Record<string, number> {
  try {
    const rows = db.prepare("SELECT decision, count(*) AS n FROM lane_pilot_jev_receipt WHERE judgment=? AND at>=? AND decision IS NOT NULL GROUP BY decision").all(ERRAND_KIND_ID, since) as Array<{ decision: string; n: number }>;
    return Object.fromEntries(rows.map((row) => [row.decision, row.n]));
  } catch { return {}; }
}

/** One line per kind: the row of the role table and the model in force at the global level, and the period's runs, outcomes and cost. */
export function kindsOverview(db: Db, settings: Record<string, unknown>, days: number): KindSummary[] {
  const since = Date.now() - days * DAY_MS;
  const runs = db.prepare("SELECT COALESCE(NULLIF(json_extract(inputs_json,'$.kind'),''),'none') AS kind, status, reason, output_json, cost_micro_usd FROM lane_pilot_wf_run WHERE workflow_id='errand' AND created_at>=?")
    .all(since) as Array<{ kind: string; status: string; reason: string | null; output_json: string | null; cost_micro_usd: number }>;
  const jev = jevShadowCounts(db, since);
  return ERRAND_KINDS_WITH_NONE.map((kind) => {
    const role = errandRoleFor(kind === "none" ? null : kind, settings);
    const chosen = resolveRoleModel(role, settings);
    const mine = runs.filter((run) => kindOf(run.kind) === kind);
    const results = mine.map((run) => errandOutcome(run.status, parse<{ state?: unknown; reason?: unknown; verified?: unknown } | null>(run.output_json, null), run.reason));
    const outcomes = results.map((row) => row.outcome);
    return {
      kind, role, providerId: chosen.providerId, model: chosen.model, effort: chosen.effort, source: chosen.source,
      runs: mine.length, done: outcomes.filter((o) => o === "done").length, checked: results.filter((row) => row.verified === "done_checked").length, blocked: outcomes.filter((o) => o === "blocked").length, failed: outcomes.filter((o) => o === "failed").length,
      costUsd: mine.reduce((sum, run) => sum + run.cost_micro_usd, 0) / 1e6, jevWouldPick: jev[kind === "none" ? "errand" : kind] ?? 0,
    };
  });
}
