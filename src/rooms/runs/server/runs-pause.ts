import { setTimeout as sleep } from "node:timers/promises";
import { pollPause } from "@lane-pilot/kit";
import { getRun } from "../../storage";
import { isRunPaused, runPausedSince, setRunPaused } from "./runs-halt";
import { conveyorState } from "../../conveyor";
import type { ServerCore } from "../../core/server";

/**
 * Pause a run at a safe boundary (SMA assess question 16, P2-8). Unlike a halt (`runs-halt.ts`: stop everything now), a
 * pause takes nothing away: a task that has not started waits before it takes a writer slot, a running attempt finishes its
 * current stage and then waits before its next attempt or turn, parked tasks stay parked. Resume lets all of it go on.
 * The flag lives in the plugin's key-value store, so a reload does not lose it.
 */
type Kv = { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };

/** A run's work waits: the run is paused, or the conveyor is off (src/rooms/conveyor). */
export async function isHeld(kv: Kv, runId: string): Promise<boolean> {
  return await isRunPaused(kv, runId) || !(await conveyorState(kv as never)).on;
}

/**
 * Holds the caller while the run is paused. Returns once it is resumed (true) or the plugin is being reloaded (false: the
 * new instance asks again). `onFirstWait` is called once, when the wait begins.
 */
export async function waitWhileRunPaused(kv: Kv, runId: string, options: { isDisposed: () => boolean; pollMs?: number; onFirstWait?: () => void }): Promise<boolean> {
  let waited = false;
  // The conveyor switch (conveyor.ts) holds every run the same way.
  while (await isHeld(kv, runId)) {
    if (options.isDisposed()) return false;
    if (!waited) { waited = true; options.onFirstWait?.(); }
    await sleep(options.pollMs ?? pollPause(5_000));
  }
  return true;
}

export type RunPauseView = {
  runId: string; paused: boolean; since: string | null; changed: boolean;
  /** Attempts with a writer at work: they finish their current stage, then wait. */
  running: Array<{ attemptId: string; taskId: string; state: string }>;
  /** Attempts that have not started: they wait before a writer slot. */
  waiting: Array<{ attemptId: string; taskId: string }>;
};

/** Pauses or resumes a run (or only reports it) and says what is running and what is waiting. */
export async function pauseRun(ctx: Pick<ServerCore, "bb" | "db">, runId: string, action: "pause" | "resume" | "status"): Promise<RunPauseView> {
  const { bb, db } = ctx;
  const run = getRun(db, runId);
  if (!run) throw new Error(`run ${runId} does not exist`);
  if (run.closed_at && action === "pause") throw new Error(`run ${runId} is closed: there is nothing to pause`);
  const before = await isRunPaused(bb.storage.kv as never, runId);
  if (action !== "status") await setRunPaused(bb.storage.kv as never, runId, action === "pause");
  const since = await runPausedSince(bb.storage.kv as never, runId);
  const rows = db.prepare("SELECT id, task_id, state FROM lane_pilot_attempt WHERE run_id=? AND state IN ('queued','spawn_requested','spawn_unknown','running','cancel_requested') ORDER BY created_at")
    .all(runId) as Array<{ id: string; task_id: string; state: string }>;
  return {
    runId, paused: since !== null, since: since === null ? null : new Date(since).toISOString(), changed: before !== (since !== null),
    running: rows.filter((row) => row.state !== "queued").map((row) => ({ attemptId: row.id, taskId: row.task_id, state: row.state })),
    waiting: rows.filter((row) => row.state === "queued").map((row) => ({ attemptId: row.id, taskId: row.task_id })),
  };
}
