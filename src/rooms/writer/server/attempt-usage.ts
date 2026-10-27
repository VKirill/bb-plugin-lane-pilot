import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { getAttempt, listAttemptsForTask, type LanePilotDatabase } from "../../storage";
import { findThreadsByMetadata } from "../../core/server";
import { withUsage } from "../../usage/server";
import { pipelineWriterStep } from "./pipeline-tag";
import { markerOf } from "./attempt-marker";

/**
 * What the threads of one task spent, charged by the turns the task caused (Astra's review of 2026-10-27, F5), never by a thread's total:
 * a sticky writer carries many tasks in one thread, so a step that read the whole history charged every task with the ones before it.
 *
 * Every attempt that goes on in an existing thread leaves a start marker (`markAttemptStart`, the moment before its turn is sent); an attempt that
 * began the thread has none (its turns start with the thread). On one thread the attempts' turns follow each other, so an attempt's window is
 * [its marker, the next marker on that thread): the windows of all attempts of a thread partition its usage, and what the tasks are charged
 * adds up to the thread's real total: nothing twice, nothing lost. The reading is a function of the thread's events and the markers, so a
 * reload that reads it again gets the same numbers.
 */
type Kv = Pick<BbPluginApi["storage"]["kv"], "get" | "set">;
export type ThreadWindow = { id: string; since?: number; until?: number };

/** The windows of the task's attempts, one per (thread, window), over every thread any of them used. */
export async function taskThreadWindows(kv: Kv, db: LanePilotDatabase, runId: string, taskId: string): Promise<ThreadWindow[]> {
  const mine = listAttemptsForTask(db, runId, taskId).map((row) => getAttempt(db, row.id)).filter((row): row is NonNullable<typeof row> => Boolean(row?.thread_id));
  const windows = new Map<string, ThreadWindow>();
  for (const threadId of new Set(mine.map((row) => row.thread_id!))) {
    const onThread = (db.prepare("SELECT id FROM lane_pilot_attempt WHERE thread_id=?").all(threadId) as Array<{ id: string }>).map((row) => row.id);
    const marks = new Map<string, number>(await Promise.all(onThread.map(async (id) => [id, await markerOf(kv, id)] as const)));
    const starts = [...new Set(marks.values())].sort((a, b) => a - b);
    for (const attempt of mine.filter((row) => row.thread_id === threadId)) {
      const since = marks.get(attempt.id) ?? 0;
      const until = starts.find((mark) => mark > since);
      const window: ThreadWindow = { id: threadId, ...(since > 0 ? { since } : {}), ...(until !== undefined ? { until } : {}) };
      windows.set(`${threadId}|${since}|${until ?? ""}`, window);
    }
  }
  return [...windows.values()];
}

/**
 * What a task's attempts spent, for the step that waited for the task: the writer threads by window, plus the helper threads the pipeline's
 * writer step started inside it (the code critic of every round: they carry the step's metadata), each counted whole. Never throws.
 */
export async function taskUsage(bb: BbPluginApi, db: LanePilotDatabase, runId: string, taskId: string): Promise<ReturnType<typeof withUsage> extends Promise<infer R> ? R : never> {
  const windows = await taskThreadWindows(bb.storage.kv, db, runId, taskId).catch(() => [] as ThreadWindow[]);
  const known = new Set((db.prepare("SELECT thread_id, holder_thread_id FROM lane_pilot_attempt WHERE run_id=?").all(runId) as Array<{ thread_id: string | null; holder_thread_id: string | null }>)
    .flatMap((row) => [row.thread_id, row.holder_thread_id]).filter((id): id is string => Boolean(id)));
  const step = pipelineWriterStep(db, runId, taskId);
  const nested = step?.stepKey
    ? ((await findThreadsByMetadata(bb as never, { lanePilotWorkflowRunId: step.runId, lanePilotWorkflowStep: step.stepKey }).catch(() => null)) ?? []).map((row) => row.id).filter((id) => !known.has(id))
    : [];
  return withUsage(bb, [...windows, ...nested]);
}
