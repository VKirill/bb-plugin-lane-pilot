import { lessonForTask } from "@lane-pilot/memory-core";
import type { TaskHistoryOutput, TaskHistoryRow } from "../../../contracts";
import { mergeShaOf } from "../../../rollback/server";
import { listTerminalTaskHistoryBatch, type LanePilotDatabase, type TaskHistoryCandidateRow } from "../../../storage";
import { attemptMetrics } from "../../../usage/server";
import { classifyOutcome, type TaskOutcome } from "../../models/task-outcome";

const DAY_MS = 86_400_000;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export interface TaskHistoryLog {
  warn?: (message: string) => void;
  debug?: (message: string) => void;
}

export interface TaskHistoryDeps {
  lessonForTask?: (db: LanePilotDatabase, taskId: string) => string | null;
  log?: TaskHistoryLog;
}

export interface TaskHistoryInput {
  projectId?: string;
  sectionId?: string;
  outcome?: TaskOutcome;
  cursor?: string;
  limit?: number;
}

interface HistoryCursor {
  finishedAt: number;
  taskId: string;
}

function encodeCursor(finishedAt: number, taskId: string): string {
  return Buffer.from(`${finishedAt}:${taskId}`, "utf8").toString("base64url");
}

function decodeCursor(raw: string): HistoryCursor | null {
  if (!raw || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  let decoded: string;
  try {
    const buf = Buffer.from(raw, "base64url");
    if (buf.toString("base64url") !== raw) return null;
    decoded = buf.toString("utf8");
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep <= 0 || sep >= decoded.length - 1) return null;
  const tsText = decoded.slice(0, sep);
  if (!/^\d+$/.test(tsText)) return null;
  const finishedAt = Number(tsText);
  if (!Number.isSafeInteger(finishedAt)) return null;
  const taskId = decoded.slice(sep + 1);
  return taskId ? { finishedAt, taskId } : null;
}

function titleFromContract(contractJson: string, fallback: string): string {
  try {
    const parsed = JSON.parse(contractJson) as { display_title?: unknown; title?: unknown };
    if (typeof parsed.display_title === "string" && parsed.display_title.trim()) return parsed.display_title.trim();
    if (typeof parsed.title === "string" && parsed.title.trim()) return parsed.title.trim();
  } catch {
    // Malformed contract JSON falls back to task ID.
  }
  return fallback;
}

function taskCostUsd(db: LanePilotDatabase, row: TaskHistoryCandidateRow, now: number): number | null {
  const startMs = row.createdAt ?? row.finishedAt;
  const days = Math.max(1, Math.ceil((now - startMs) / DAY_MS) + 1);
  try {
    const report = attemptMetrics(db, { projectId: row.projectId, days, now, taskId: row.taskId });
    const priced = report.attempts.filter((attempt) => attempt.costUsd !== null);
    if (priced.length === 0) return null;
    return priced.reduce((sum, attempt) => sum + (attempt.costUsd ?? 0), 0);
  } catch {
    return null;
  }
}

/**
 * Keyset-paginated read model for Task History (`task_history`): terminal tasks ordered by
 * `(finished_at DESC, task_id DESC)` with optional project, section, and post-classification outcome filters.
 */
export function taskHistory(
  db: LanePilotDatabase,
  input: TaskHistoryInput = {},
  now: number = Date.now(),
  deps: TaskHistoryDeps = {},
): TaskHistoryOutput {
  const started = Date.now();
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(input.limit ?? DEFAULT_LIMIT)));
  const batchSize = limit * 3;

  let scanCursor: HistoryCursor | null = null;
  if (input.cursor !== undefined) {
    scanCursor = decodeCursor(input.cursor);
    if (!scanCursor) {
      deps.log?.warn?.("[console] task_history bad cursor");
    }
  }

  const selected: Array<{ row: TaskHistoryCandidateRow; outcome: TaskOutcome }> = [];
  let hasMore = false;

  while (true) {
    const batch = listTerminalTaskHistoryBatch(db, {
      projectId: input.projectId ?? null,
      sectionId: input.sectionId ?? null,
      cursor: scanCursor,
      limit: batchSize,
    });
    if (batch.length === 0) break;

    for (const row of batch) {
      const outcome = classifyOutcome({ finalState: row.finalState, attemptCount: row.attemptCount });
      if (!outcome) continue;
      if (input.outcome && outcome !== input.outcome) continue;
      if (selected.length < limit) {
        selected.push({ row, outcome });
      } else {
        hasMore = true;
        break;
      }
    }

    if (hasMore || batch.length < batchSize) break;
    const last = batch[batch.length - 1]!;
    scanCursor = { finishedAt: last.finishedAt, taskId: last.taskId };
  }

  const readLesson = deps.lessonForTask ?? lessonForTask;
  const rows: TaskHistoryRow[] = selected.map(({ row, outcome }) => ({
    runId: row.runId,
    taskId: row.taskId,
    projectId: row.projectId,
    title: titleFromContract(row.contractJson, row.taskId),
    outcome,
    attempts: row.attemptCount,
    finishedAt: row.finishedAt,
    durationMs: row.createdAt !== null && row.finishedAt >= row.createdAt ? row.finishedAt - row.createdAt : null,
    costUsd: taskCostUsd(db, row, now),
    mergeSha: mergeShaOf(db, row.attemptId),
    failureReason: row.reason ?? null,
    lessonMemoryId: readLesson(db, row.taskId),
  }));

  const lastRow = selected[selected.length - 1]?.row;
  const nextCursor = hasMore && lastRow ? encodeCursor(lastRow.finishedAt, lastRow.taskId) : null;
  const elapsed = Math.max(0, Date.now() - started);
  deps.log?.debug?.(`[console] task_history rows=${rows.length} next=${nextCursor !== null} ms=${elapsed}`);

  return { rows, nextCursor };
}
