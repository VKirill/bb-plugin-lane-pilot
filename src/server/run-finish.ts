import { closeRun, getAttempt, getRun, listOpenAttempts, openDatabase, releaseActivation } from "../database";
import { stringAt, valueAt } from "./values";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
export function cancelRejection(db: ReturnType<typeof openDatabase>, attempt: NonNullable<ReturnType<typeof getAttempt>>): string | null {
  const run = getRun(db, attempt.run_id);
  if (!run || run.closed_at || (run.state !== "pending" && run.state !== "running")) {
    return `cancel is not legal for ${run?.state ?? "missing"} run`;
  }
  if (!["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested"].includes(attempt.state)) {
    return `cancel is not legal from ${attempt.state}`;
  }
  return null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const isGone = (cause: unknown) => /\b404\b|not found/i.test(cause instanceof Error ? cause.message : String(cause));

/**
 * Closes open runs nobody can come back to: the PM chat was deleted or archived, or a run never got a PM chat in a
 * day. A run is opened per Lane Pilot chat and used to stay «running» forever once the chat was gone. Live and idle
 * chats are left alone, as is any run with an open attempt or a chat that could not be read.
 */
export async function closeAbandonedRuns(bb: BbPluginApi, db: ReturnType<typeof openDatabase>, now = Date.now()): Promise<string[]> {
  const rows = db.prepare("SELECT id,project_id,pm_thread_id,created_at FROM lane_pilot_run WHERE closed_at IS NULL AND state IN ('pending','running')")
    .all() as Array<{ id: string; project_id: string; pm_thread_id: string | null; created_at: number }>;
  const busy = new Set(listOpenAttempts(db).map((attempt) => attempt.run_id));
  const closed: string[] = [];
  for (const row of rows) {
    if (busy.has(row.id)) continue;
    let abandoned: boolean;
    if (!row.pm_thread_id) abandoned = now - row.created_at > DAY_MS;
    else {
      const thread = await bb.sdk.threads.get({ threadId: row.pm_thread_id }).then((value) => value as unknown, (cause: unknown) => (isGone(cause) ? null : undefined));
      if (thread === undefined) continue;
      abandoned = thread === null || valueAt(thread, "archivedAt") != null;
    }
    if (abandoned && closeRun(db, row.id, "sweep")) {
      releaseActivation(db, row.project_id, row.id);
      await cleanupRunEnvironments(bb, db, row.id);
      closed.push(row.id);
    }
  }
  return closed;
}

/**
 * A closed run's attempt worktrees that BB made (managed environments) are archived with their threads and
 * deleted, so they do not pile up on the host. Kept while the run is open, so the owner can still read the writers.
 */
export async function cleanupRunEnvironments(bb: BbPluginApi, db: ReturnType<typeof openDatabase>, runId: string): Promise<string[]> {
  const run = getRun(db, runId);
  const rows = db.prepare("SELECT DISTINCT environment_id FROM lane_pilot_attempt WHERE run_id=? AND environment_id IS NOT NULL").all(runId) as Array<{ environment_id: string }>;
  const removed: string[] = [];
  for (const { environment_id: environmentId } of rows) {
    if (environmentId === run?.writer_environment_id) continue;
    try {
      await bb.sdk.environments.archiveThreads({ environmentId });
      // With its threads archived BB retires the worktree itself about five minutes later; a delete that BB
      // refuses as still «ready» meanwhile is fine (seen live on 2026-10-02).
      await bb.sdk.environments.delete({ environmentId }).catch((cause: unknown) => {
        if (!/cannot be deleted while ready/i.test(cause instanceof Error ? cause.message : String(cause))) throw cause;
      });
      removed.push(environmentId);
    } catch (cause) {
      bb.log.warn(`Lane Pilot could not remove environment ${environmentId} of ${runId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  return removed;
}

export async function finishRunSafely(
  bb: BbPluginApi,
  db: ReturnType<typeof openDatabase>,
  projectId: string,
  runId: string,
  closedBy: "rpc" | "cli",
): Promise<void> {
  const run = getRun(db, runId);
  if (!run || run.project_id !== projectId) throw new Error("run does not belong to this project");
  if (run.closed_at) {
    releaseActivation(db, projectId, runId);
    return;
  }
  if (listOpenAttempts(db).some((attempt) => attempt.run_id === runId)) {
    throw new Error("running attempts remain; cancel them before finishing the run");
  }
  if (run.pm_thread_id) {
    const threads = bb.sdk.threads as typeof bb.sdk.threads & {
      listRunning?: (query?: Record<string, unknown>) => Promise<Array<{ id: string }>>;
    };
    if (typeof threads.listRunning !== "function") throw new Error("cannot verify PM status: threads.listRunning is unavailable");
    // A PM thread the user deleted has nothing left to observe; the run must still be closable.
    const existing = await threads.get({ threadId: run.pm_thread_id }).catch((cause: unknown) => { if (isGone(cause)) return null; throw cause; });
    if (existing !== null) {
      await threads.stop({ threadId: run.pm_thread_id });
      const info = await threads.get({ threadId: run.pm_thread_id });
      const status = stringAt(info, "status");
      if (status !== "idle" && status !== "error") {
        throw new Error(`cannot finish PM run: PM thread status is ${status ?? "unknown"}`);
      }
      const running = await threads.listRunning({});
      if (running.some((thread) => thread.id === run.pm_thread_id)) {
        throw new Error("cannot finish PM run: PM thread is still listed as running");
      }
    }
  }
  if (!closeRun(db, runId, closedBy)) throw new Error("running attempts remain; cancel them before finishing the run");
  releaseActivation(db, projectId, runId);
  void cleanupRunEnvironments(bb, db, runId);
}
