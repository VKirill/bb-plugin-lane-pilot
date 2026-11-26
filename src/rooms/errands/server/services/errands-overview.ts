import { resolveRoleModel } from "@lane-pilot/models";
import { listErrandKindRows, listErrandWfRuns, wfEffectResultJson } from "@lane-pilot/workflow-engine";
import { errandOutcome } from "../../../contracts/server";
import { errandRoleFor, scheduleNameOf } from "../../../schedule";
import { runPmThreadId } from "../../../storage";
import {
  ERRAND_KINDS_WITH_NONE,
  errandTitle,
  kindOf,
  type ErrandRow,
  type ErrandSource,
  type KindSummary,
} from "../../models/errands";

/**
 * The «Errands» page (owner, 2026-11-01: «a tab where I see which errands the system has and can grow them»): the kinds with the model each
 * runs on and the period's counts, and the recent errand runs themselves. Everything is read from the workflow journal: an errand is a run
 * of the graph `errand` (src/rooms/errands/server/services/errand-graph.ts), its kind, model and source sit in `inputs_json`, its verdict in `output_json`,
 * its helper thread in the `errand.spawn` effect, its cost in the run's own columns. No table of its own: a new kind is a row in
 * src/rooms/schedule/errand-kinds.ts and shows here by itself.
 */
type Db = { prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown } };

const DAY_MS = 86_400_000;
const parse = <T,>(text: string | null | undefined, fallback: T): T => { try { return text ? (JSON.parse(text) as T) : fallback; } catch { return fallback; } };

type RunRow = {
  id: string; project_id: string | null; status: string; reason: string | null; inputs_json: string; output_json: string | null;
  tokens_used: number; cost_micro_usd: number; created_at: number; updated_at: number; thread_id: string | null; pm_thread_id: string | null; schedule_name: string | null;
};

/** The errand runs of a period, newest first, with their kind, model, outcome, source, helper thread and cost. */
export function listErrands(db: Db, input: { days: number; kind?: string | undefined; projectId?: string | undefined; limit?: number | undefined }): ErrandRow[] {
  const since = Date.now() - input.days * DAY_MS;
  const kind = input.kind && input.kind !== "all" ? input.kind : null;
  const rows = listErrandWfRuns(db as never, { since, projectId: input.projectId ?? null, kind, limit: input.limit ?? 200 }).map((row) => {
    const sid = (parse<Record<string, unknown>>(row.inputs_json, {}) as { scheduleId?: unknown }).scheduleId;
    return { ...row, pm_thread_id: row.link_run_id ? runPmThreadId(db as never, row.link_run_id) : null, schedule_name: typeof sid === "string" ? scheduleNameOf(db as never, sid) : null } satisfies RunRow;
  });
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

/** One line per kind: the row of the role table and the model in force at the global level, and the period's runs, outcomes and cost. */
export function kindsOverview(db: Db, settings: Record<string, unknown>, days: number): KindSummary[] {
  const since = Date.now() - days * DAY_MS;
  const runs = listErrandKindRows(db as never, since);
  return ERRAND_KINDS_WITH_NONE.map((kind) => {
    const role = errandRoleFor(kind === "none" ? null : kind, settings);
    const chosen = resolveRoleModel(role, settings);
    const mine = runs.filter((run) => kindOf(run.kind) === kind);
    const results = mine.map((run) => errandOutcome(run.status, parse<{ state?: unknown; reason?: unknown; verified?: unknown } | null>(run.output_json, null), run.reason));
    const outcomes = results.map((row) => row.outcome);
    return {
      kind, role, providerId: chosen.providerId, model: chosen.model, effort: chosen.effort, source: chosen.source,
      runs: mine.length, done: outcomes.filter((o) => o === "done").length, checked: results.filter((row) => row.verified === "done_checked").length, blocked: outcomes.filter((o) => o === "blocked").length, failed: outcomes.filter((o) => o === "failed").length,
      costUsd: mine.reduce((sum, run) => sum + run.cost_micro_usd, 0) / 1e6,
    };
  });
}

/** What the `spawn` effect of a run's helper step recorded: the thread and the browser machine, once the thread exists. */
export function errandSpawnOf(db: Db, runId: string): { threadId: string; browserMachine: string | null } | null {
  const resultJson = wfEffectResultJson(db as never, runId, "errand.spawn");
  try {
    const value = JSON.parse(resultJson ?? "null") as { threadId?: unknown; browserMachine?: unknown } | null;
    return value && typeof value.threadId === "string"
      ? { threadId: value.threadId, browserMachine: typeof value.browserMachine === "string" ? value.browserMachine : null }
      : null;
  } catch {
    return null;
  }
}
