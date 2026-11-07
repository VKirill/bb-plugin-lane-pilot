import type Database from "better-sqlite3";
import { listAttemptHistory, listStageReceipts, stageEventsForTask, stageEventKeysSince } from "../../storage";

import { costUsd } from "@lane-pilot/models";
import { billedFrom, parseBreakdown } from "../../usage";
import { graphStats, taskGraph, type AttemptIn, type GraphStats, type ReceiptIn, type StageEventIn, type TaskGraph, type TaskSummary, type StageCell, type Tokens, type UsageIn } from "../logic";

/** What the work graph reads from the plugin's database: stage events and receipts, attempts and the token cursor of each thread. */
const DAY_MS = 86_400_000;
export const STATS_TASKS = 400;
type Key = { runId: string; taskId: string };

const price = (model: string, billed: Tokens) => costUsd(model, { uncached: billed.fresh, cacheRead: billed.cacheRead, cacheWrite: billed.cacheWrite, output: billed.output });

/** The usage room's cursor read, injected by the composition root (usage imports the work graph, so the graph cannot import usage). */
export type TokenCursorReader = (db: Database.Database, threadId: string) =>
  { provider_id: string; last_provider: string; last_model: string; total_json: string } | undefined;

function usageReader(db: Database.Database, cursorRow: TokenCursorReader) {
  const cache = new Map<string, UsageIn | undefined>();
  return (threadId: string): UsageIn | undefined => {
    if (cache.has(threadId)) return cache.get(threadId);
    const row = cursorRow(db, threadId);
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
  const events = stageEventsForTask(db, key.runId, key.taskId).map((row): StageEventIn => ({ stageId: row.stage_id, state: row.state, at: row.occurred_at }));
  const receipts = listStageReceipts(db, key.runId, key.taskId)
    .map((row): ReceiptIn => ({ stageId: row.stageId, state: row.state, threadId: row.threadId, providerId: row.providerId, model: row.model, reason: row.reason ? row.reason.slice(0, 400) : null, updatedAt: row.updatedAt }));
  const attempts = listAttemptHistory(db, key.runId, key.taskId)
    .map((row): AttemptIn => ({ id: row.id, no: row.attempt_no, state: row.state, threadId: row.thread_id, createdAt: row.created_at, updatedAt: row.updated_at }));
  return taskGraph({ events, receipts, attempts, usage, price, ...(turns ? { turns } : {}) });
}

/** One task, every stage and who ran it; `turns` is filled by the caller (BB knows the turns of a thread). */
export function workGraphTask(db: Database.Database, key: Key, cursorRow: TokenCursorReader, turns?: (threadId: string) => number | null): TaskGraph {
  return readOne(db, key, usageReader(db, cursorRow), turns);
}

/** The cells and the summary line of many tasks, for the task list. */
export function workGraphStrips(db: Database.Database, keys: readonly Key[], cursorRow: TokenCursorReader): Record<string, { cells: StageCell[]; summary: TaskSummary }> {
  const usage = usageReader(db, cursorRow);
  return Object.fromEntries(keys.map((key) => {
    const graph = readOne(db, key, usage);
    return [`${key.runId}:${key.taskId}`, { cells: graph.cells, summary: graph.summary }];
  }));
}

/** Stages and models over the tasks that had a stage event in the window; drills and the projects the caller leaves out are not counted. */
export function workGraphStats(db: Database.Database, input: { projectId?: string; days: number; excludeProjectIds?: readonly string[]; now?: number }, cursorRow: TokenCursorReader): GraphStats & { days: number; capped: boolean } {
  const since = (input.now ?? Date.now()) - input.days * DAY_MS;
  // The newest tasks first, at most STATS_TASKS of them: the read runs on the plugin server's event loop.
  const keys = stageEventKeysSince(db, since, input.projectId)
    .filter((row) => !row.task_id.startsWith("drill-") && !(input.excludeProjectIds ?? []).includes(row.project_id)).slice(0, STATS_TASKS);
  const usage = usageReader(db, cursorRow);
  return { days: input.days, capped: keys.length >= STATS_TASKS, ...graphStats(keys.map((row) => readOne(db, { runId: row.run_id, taskId: row.task_id }, usage))) };
}
