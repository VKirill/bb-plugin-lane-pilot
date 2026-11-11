import type { BlockedBy } from "../../runs/server";
import { countOtherLiveAttemptsInArea, getRun, listOpenAttempts } from "../../storage";

/** The area's copy stays while it holds queued or running work; with none, the merge removes it now, not at the sweep (WT2 A2). */
export function areaHasLiveWork(db: Parameters<typeof countOtherLiveAttemptsInArea>[0], input: { projectId: string; taskId: string }): boolean {
  return countOtherLiveAttemptsInArea(db, input.taskId) > 0;
}

/** How long an accepted attempt waits for another task's merge into the same checkout before it reports the block. */
export const MERGE_QUEUE_MS = 15 * 60_000;
/** How long finished work waits for someone's uncommitted edits in the base checkout to be committed or put away. */
export const DIRTY_BASE_WAIT_MS = 2 * 3600_000;
export const dirtyBase = (merged:{ status:string; reason?:string|null }) => merged.status === "conflict" && Boolean(merged.reason?.startsWith("base checkout has uncommitted changes"));

/** Who holds the checkout: the open attempt whose task the holder's commit message names. */
export function mergeHolder(db: Parameters<typeof getRun>[0], runId: string, holder: string | null, since: number): BlockedBy {
  const projectId = getRun(db, runId)?.project_id;
  const taskId = holder?.split(":")[0]?.trim() || null;
  const attempt = taskId ? listOpenAttempts(db).find((row) => row.task_id === taskId && row.project_id === projectId) : undefined;
  return { kind:"merge-lock", holderTaskId:taskId, holderThreadId:attempt?.thread_id ?? null, holderAttemptId:attempt?.id ?? null,
    since:new Date(since).toISOString(), retryAfterSec:60, detail:holder };
}
