import { isFailedAttemptState, isOpenAttemptState, type AttemptState, type RunState } from "../../contracts/state-machine";

/** A task's latest attempt with its writer-agent stage, as refreshRun and the task graph read it (listTaskLatestAttempts). */
export type LatestAttempt = { state: string; writerStage: string | null };

/** A writer stage still open: it stays running between the attempts of one writer loop, pending while the next one waits. */
const LIVE_WRITER_STAGE = new Set(["pending", "running"]);

/**
 * Whether a failed latest attempt is the gap before its writer loop's next attempt. A retry is a new attempt row and the
 * failed one keeps its state (validation_failed, timeout, provider_error…), so the state alone cannot tell the gap from
 * the task's end: the writer-agent stage can — the loop closes it (failed, canceled) when it gives up. No clock is read:
 * a stage left open by a cut loop stays at work until the existing reconcile closes it (status-consistency-fix.md).
 */
export function attemptRetrying(attempt: LatestAttempt): boolean {
  return attempt.state !== "blocked" && isFailedAttemptState(attempt.state) && LIVE_WRITER_STAGE.has(attempt.writerStage ?? "");
}

/** The task is at work: its latest attempt is open (queued, spawning, running, being canceled) or between two attempts. */
export const attemptAtWork = (attempt: LatestAttempt): boolean => isOpenAttemptState(attempt.state) || attemptRetrying(attempt);

/** The task ended without acceptance: blocked, or failed with its writer loop closed. */
export const attemptEnded = (attempt: LatestAttempt): boolean => isFailedAttemptState(attempt.state) && !attemptRetrying(attempt);

/**
 * A run's state from the latest attempt of each piece of work: accepted when all are, running while any is at work,
 * blocked otherwise (every one accepted, canceled or ended). A bare state carries no writer-stage evidence and keeps
 * §3.5's reading, where a failed attempt still waits for its retry (running); refreshRun passes the evidence.
 */
export function aggregateRun(tasks: ReadonlyArray<AttemptState | LatestAttempt>): RunState {
  if (tasks.length === 0) return "pending";
  const states = tasks.map((task) => (typeof task === "string" ? task : task.state));
  if (states.every((state) => state === "accepted")) return "accepted";
  const atWork = tasks.some((task) => (typeof task === "string" ? isOpenAttemptState(task) || isFailedAttemptState(task) && task !== "blocked" : attemptAtWork(task)));
  return atWork ? "running" : "blocked";
}
