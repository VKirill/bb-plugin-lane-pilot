import { closeRun, getAttempt, getRun, listOpenAttempts, openDatabase, releaseActivation } from "../database";
import { stringAt, valueAt } from "./values";
import { RETRY_ELIGIBLE } from "../state-machine";
import { STICKY_WINDOW_MS } from "./writer/sticky";
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
export async function closeAbandonedRuns(bb: BbPluginApi, db: ReturnType<typeof openDatabase>, now = Date.now(), signal?: AbortSignal, onlyPmThreadId?: string): Promise<string[]> {
  const rows = (db.prepare("SELECT id,project_id,pm_thread_id,created_at FROM lane_pilot_run WHERE closed_at IS NULL AND state IN ('pending','running')")
    .all() as Array<{ id: string; project_id: string; pm_thread_id: string | null; created_at: number }>)
    .filter((row) => onlyPmThreadId === undefined || row.pm_thread_id === onlyPmThreadId);
  const busy = new Set(listOpenAttempts(db).map((attempt) => attempt.run_id));
  const closed: string[] = [];
  for (const row of rows) {
    signal?.throwIfAborted();
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

const ENVIRONMENT_GRACE_MS = 30 * 60 * 1000;
const FINAL = new Set(["accepted", "blocked", "canceled"]);

/** A reload or a disabled plugin ended this instance: its host and API calls fail from now on, the next instance goes on. */
export const pluginStopped = (cause: unknown) => /stale API handle|generation .* is retired|plugin .* (reloaded|disabled)/i.test(cause instanceof Error ? cause.message : String(cause));

export type WorktreeSnapshot = (hostId:string, worktreePath:string, name:string) => Promise<{ status:"clean"|"saved"|"missing"|"failed"; path:string|null; reason:string|null }>;

/**
 * Attempt worktrees of an open run whose work is over, archived with their threads and deleted the same way as on run
 * close. A Lane chat keeps its run open for days and every attempt got its own BB worktree (≈2 GB in SelfyStudio):
 * 110 filled the OVH disk on 2026-10-03 and the host went offline. A worktree goes when, for 30 minutes, each of its
 * attempts has ended (accepted, blocked, canceled) or failed and been replaced by a later attempt of the same task;
 * a worktree whose holder thread was made but never bound to its attempt goes on the same terms. A failed attempt
 * nothing replaced, the run's own workspace and a running attempt stay. Uncommitted edits and commits no other branch
 * has are saved as a patch first (~/.lane-pilot/released/<environment>.patch); if that fails the worktree stays.
 * The worktree of an area's last accepted task stays for the sticky window: the area's next task continues there.
 */
export async function cleanupFinishedAttemptEnvironments(bb: BbPluginApi, db: ReturnType<typeof openDatabase>, snapshot: WorktreeSnapshot, now = Date.now(), signal?: AbortSignal): Promise<string[]> {
  const rows = db.prepare(`SELECT a.environment_id AS environmentId, a.holder_thread_id AS holderThreadId, a.state, a.updated_at AS updatedAt, a.run_id AS runId,
      r.writer_environment_id AS runEnvironmentId, json_extract(t.contract_json,'$.area') AS area,
      EXISTS(SELECT 1 FROM lane_pilot_attempt b WHERE b.run_id=a.run_id AND b.task_id=a.task_id AND b.created_at>a.created_at) AS superseded
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id LEFT JOIN lane_pilot_task t ON t.id=a.task_id
    WHERE a.environment_id IS NOT NULL OR a.holder_thread_id IS NOT NULL`).all() as Array<{
      environmentId:string|null; holderThreadId:string|null; state:string; updatedAt:number; runId:string; runEnvironmentId:string|null; superseded:number; area:string|null }>;
  const done = (row:(typeof rows)[number]) => FINAL.has(row.state) || ((RETRY_ELIGIBLE as string[]).includes(row.state) && row.superseded === 1);
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    signal?.throwIfAborted();
    let environmentId = row.environmentId;
    // A holder whose worktree was never bound: its attempt ended before setAttemptWorkspace. Asked only once that attempt is over.
    if (!environmentId && row.holderThreadId && done(row) && row.updatedAt < now - ENVIRONMENT_GRACE_MS) {
      environmentId = stringAt(await bb.sdk.threads.get({ threadId: row.holderThreadId }).catch(() => null), "environmentId");
    }
    if (!environmentId || environmentId === row.runEnvironmentId) continue;
    groups.set(environmentId, [...(groups.get(environmentId) ?? []), row]);
  }
  const removed: string[] = [];
  for (const [environmentId, attempts] of groups) {
    signal?.throwIfAborted();
    if (!attempts.every(done) || Math.max(...attempts.map((row) => row.updatedAt)) >= now - ENVIRONMENT_GRACE_MS) continue;
    if (attempts.some((row) => row.state === "accepted" && row.area && row.updatedAt >= now - STICKY_WINDOW_MS)) continue;
    const environment = await bb.sdk.environments.get({ environmentId }).then((value) => value as unknown, (cause: unknown) => (isGone(cause) ? null : undefined));
    if (environment === null || environment === undefined) continue;
    const phase = stringAt(valueAt(environment, "lifecycle"), "phase");
    if (phase && phase !== "active") continue;
    const hostId = stringAt(environment, "hostId"), path = stringAt(environment, "path");
    if (hostId && path) {
      const saved = await snapshot(hostId, path, environmentId).catch((cause: unknown) => ({ status:"failed" as const, path:null, reason:cause instanceof Error ? cause.message : String(cause) }));
      // The sweep of an instance a reload ended stops here; the new instance sweeps the same worktrees.
      if (saved.status === "failed" && pluginStopped(saved.reason)) return removed;
      if (saved.status === "failed") { bb.log.warn(`Lane Pilot kept worktree ${environmentId}: its changes could not be saved (${saved.reason})`); continue; }
      if (saved.status === "saved") bb.log.info(`Lane Pilot saved the changes of worktree ${environmentId} to ${saved.path}`);
    }
    try {
      await bb.sdk.environments.archiveThreads({ environmentId });
      await bb.sdk.environments.delete({ environmentId }).catch((cause: unknown) => {
        if (!/cannot be deleted while ready/i.test(cause instanceof Error ? cause.message : String(cause))) throw cause;
      });
      removed.push(environmentId);
    } catch (cause) {
      bb.log.warn(`Lane Pilot could not remove environment ${environmentId} of ${attempts[0]!.runId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  return removed;
}

/**
 * Lane Pilot's own worktrees (the provider's, and a section with its own repository's) that no BB environment owns
 * (`environment_id IS NULL`): an area task keeps its worktree after the merge for the sticky window; any other task's
 * worktree is released once every attempt that used it has ended (or failed and been replaced) and 30 minutes have passed.
 * A worktree with an open attempt stays. The accepted and failed paths remove their own worktree; this catches what a
 * reload, a crash or the provider's fallback left on disk (audit 2026-10-08, H9: a task without an area kept it for good).
 * Returns the removed paths.
 */
export async function cleanupStickyLaneWorktrees(db: ReturnType<typeof openDatabase>, remove:(hostId:string, basePath:string, worktreePath:string) => Promise<boolean>, released:Set<string>, now = Date.now(), signal?: AbortSignal): Promise<string[]> {
  const rows = db.prepare(`SELECT a.workspace_path AS path, r.writer_workspace_path AS base, r.writer_host_id AS hostId, a.state, a.updated_at AS updatedAt,
      json_extract(t.contract_json,'$.area') IS NOT NULL AS area,
      EXISTS(SELECT 1 FROM lane_pilot_attempt b WHERE b.run_id=a.run_id AND b.task_id=a.task_id AND b.created_at>a.created_at) AS superseded
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id JOIN lane_pilot_task t ON t.id=a.task_id
    WHERE a.environment_id IS NULL AND a.workspace_path IS NOT NULL AND a.workspace_path<>r.writer_workspace_path`).all() as Array<{
      path:string; base:string|null; hostId:string|null; state:string; updatedAt:number; area:number; superseded:number }>;
  const groups = new Map<string, typeof rows>();
  for (const row of rows) groups.set(row.path, [...(groups.get(row.path) ?? []), row]);
  const OPEN = ["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested"];
  const removed:string[] = [];
  for (const [path, attempts] of groups) {
    signal?.throwIfAborted();
    const first = attempts[0]!, area = attempts.some((row) => row.area === 1);
    // An area task's worktree waits the sticky window whatever happened; another task's waits only for its attempts to end.
    const idle = area ? !attempts.some((row) => OPEN.includes(row.state))
      : attempts.every((row) => FINAL.has(row.state) || ((RETRY_ELIGIBLE as string[]).includes(row.state) && row.superseded === 1));
    const quiet = Math.max(...attempts.map((row) => row.updatedAt)) < now - (area ? STICKY_WINDOW_MS : ENVIRONMENT_GRACE_MS);
    if (released.has(path) || !idle || !quiet || !first.base || !first.hostId) continue;
    if (await remove(first.hostId, first.base, path).catch(() => false)) removed.push(path);
    released.add(path);
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
