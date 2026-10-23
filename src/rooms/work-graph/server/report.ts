import type Database from "better-sqlite3";
import { costUsd } from "@lane-pilot/models";
import { billedFrom, parseBreakdown } from "../../usage";
import { graphStats, taskGraph, type AttemptIn, type GraphStats, type ReceiptIn, type StageEventIn, type TaskGraph, type TaskSummary, type StageCell, type Tokens, type UsageIn } from "../logic";

/** What the work graph reads from the plugin's database: stage events and receipts, attempts and the token cursor of each thread. */
const DAY_MS = 86_400_000;
export const STATS_TASKS = 400;
type Key = { runId: string; taskId: string };

const price = (model: string, billed: Tokens) => costUsd(model, { uncached: billed.fresh, cacheRead: billed.cacheRead, cacheWrite: billed.cacheWrite, output: billed.output });

function usageReader(db: Database.Database) {
  const query = db.prepare("SELECT provider_id, last_provider, last_model, total_json FROM lane_pilot_token_cursor WHERE thread_id = ?");
  const cache = new Map<string, UsageIn | undefined>();
  return (threadId: string): UsageIn | undefined => {
    if (cache.has(threadId)) return cache.get(threadId);
    const row = query.get(threadId) as { provider_id: string; last_provider: string; last_model: string; total_json: string } | undefined;
    const usage = row ? (() => {
      const billed = billedFrom(parseBreakdown(row.total_json));
      return { providerId: row.last_provider || row.provider_id || null, model: row.last_model || null,
        billed: { fresh: billed.uncached, cacheRead: billed.cacheRead, cacheWrite: billed.cacheWrite, output: billed.output } };
    })() : undefined;
    cache.set(threadId, usage);
    return usage;
  };
}

function readOne(db: Database.Database, key: Key, usage: ReturnType<typeof usageReader>, turns?: (threadId: string) => number | null): TaskGraph {
  const events = (db.prepare("SELECT stage_id, state, occurred_at FROM lane_pilot_stage_event WHERE run_id = ? AND task_id = ? ORDER BY id").all(key.runId, key.taskId) as
    Array<{ stage_id: string; state: string; occurred_at: number }>).map((row): StageEventIn => ({ stageId: row.stage_id, state: row.state, at: row.occurred_at }));
  const receipts = (db.prepare("SELECT stage_id, state, thread_id, provider_id, model, reason, updated_at FROM lane_pilot_stage_receipt WHERE run_id = ? AND task_id = ?").all(key.runId, key.taskId) as
    Array<{ stage_id: string; state: string; thread_id: string | null; provider_id: string | null; model: string | null; reason: string | null; updated_at: number }>)
    .map((row): ReceiptIn => ({ stageId: row.stage_id, state: row.state, threadId: row.thread_id, providerId: row.provider_id, model: row.model, reason: row.reason ? row.reason.slice(0, 400) : null, updatedAt: row.updated_at }));
  const attempts = (db.prepare("SELECT id, attempt_no, state, thread_id, created_at, updated_at FROM lane_pilot_attempt WHERE run_id = ? AND task_id = ? ORDER BY attempt_no").all(key.runId, key.taskId) as
    Array<{ id: string; attempt_no: number; state: string; thread_id: string | null; created_at: number; updated_at: number }>)
    .map((row): AttemptIn => ({ id: row.id, no: row.attempt_no, state: row.state, threadId: row.thread_id, createdAt: row.created_at, updatedAt: row.updated_at }));
  return taskGraph({ events, receipts, attempts, usage, price, ...(turns ? { turns } : {}) });
}

/** One task, every stage and who ran it; `turns` is filled by the caller (BB knows the turns of a thread). */
export function workGraphTask(db: Database.Database, key: Key, turns?: (threadId: string) => number | null): TaskGraph {
  return readOne(db, key, usageReader(db), turns);
}

/** The cells and the summary line of many tasks, for the task list. */
export function workGraphStrips(db: Database.Database, keys: readonly Key[]): Record<string, { cells: StageCell[]; summary: TaskSummary }> {
  const usage = usageReader(db);
  return Object.fromEntries(keys.map((key) => {
    const graph = readOne(db, key, usage);
    return [`${key.runId}:${key.taskId}`, { cells: graph.cells, summary: graph.summary }];
  }));
}

/** Stages and models over the tasks that had a stage event in the window; drills and the projects the caller leaves out are not counted. */
export function workGraphStats(db: Database.Database, input: { projectId?: string; days: number; excludeProjectIds?: readonly string[]; now?: number }): GraphStats & { days: number; capped: boolean } {
  const since = (input.now ?? Date.now()) - input.days * DAY_MS;
  // The newest tasks first, at most STATS_TASKS of them: the read runs on the plugin server's event loop.
  const keys = (db.prepare(`SELECT run_id, task_id, project_id, max(occurred_at) AS at FROM lane_pilot_stage_event WHERE occurred_at >= ? ${input.projectId ? "AND project_id = ?" : ""}
    GROUP BY run_id, task_id ORDER BY at DESC`).all(since, ...(input.projectId ? [input.projectId] : [])) as Array<{ run_id: string; task_id: string; project_id: string }>)
    .filter((row) => !row.task_id.startsWith("drill-") && !(input.excludeProjectIds ?? []).includes(row.project_id)).slice(0, STATS_TASKS);
  const usage = usageReader(db);
  return { days: input.days, capped: keys.length >= STATS_TASKS, ...graphStats(keys.map((row) => readOne(db, { runId: row.run_id, taskId: row.task_id }, usage))) };
}
