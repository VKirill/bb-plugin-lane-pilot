import type { PrototypeConfig, TaskV2 } from "../../contracts";
import type { ServerCore } from "../../core/server";

/**
 * What the writer knows when an attempt (or the task's whole writer session) ends.
 *
 * `scope: "attempt"` is emitted once per finishWriterAttempt — every spawn, every feedback turn's
 * attempt, every emergency fallback. `scope: "task"` is emitted once from start.ts's epilogue, when
 * the task's writer session is over for good (accepted, blocked, canceled) — a task may have had
 * several attempts by then, so a task-scope subscriber fires once, not per attempt.
 *
 * Subscribers are the reactions other rooms used to have hard-wired into finish.ts and start.ts:
 * metrics, learning records, notices, the post-merge check, the after-acceptance graph. They run in
 * registration order (see tests/writer-attempt-finished.test.ts); a subscriber that throws is logged
 * and the rest still run — a reaction must never change the attempt's outcome.
 */
export interface AttemptFinished {
  scope: "attempt" | "task";
  projectId: string;
  runId: string;
  taskId: string;
  /** The attempt the outcome is on. Task scope: the last attempt of the session. */
  attemptId: string;
  pmThreadId: string;
  writerThreadId: string | null;
  task: TaskV2;
  config: PrototypeConfig;
  /** The terminal status (`accepted`, `blocked`, `canceled`, a retry-eligible failure, `error` when the finish threw). */
  status: string;
  reason: string | null;
  /** The finish's result record, or the loop's last record at task scope; null when the body threw. */
  result: Record<string, unknown> | null;
  /** The provider/model pair the finished writer ran, when a trace recorded one. */
  writerSelection?: { providerId: string; model: string } | null;
  /** The class and intervention the failure judgment gave (task scope). */
  judged?: { failureClass: string; mast: string | null; intervention: string | null; streak: number | null };
  /** The verified candidate, for observational subscribers (the finish scan). */
  candidate?: { output: unknown; produced: string[]; verification: unknown[] };
  /** The merge's landing facts (attempt scope, when a worktree merge or a live acceptance ran). */
  landed?: { basePath: string; commit: string | null; produced: string[]; live: boolean; worktreePath: string | null };
  /** Checks green in the attempt's own worktree (the post-merge check reads clashes against them). */
  greenInWorktree?: readonly string[];
  /** The candidate passed every gate up to the acceptance receipt (the finish scan's point). */
  acceptanceReached?: boolean;
  /** A running writer was stopped mid-wait: the budget/appetite ran out or the queued follow-up was deleted (the settle reaction). */
  writerStopped?: boolean;
  /** The attempt the acceptance names (task scope, accepted only). */
  acceptedAttemptId?: string | null;
  /** The class of the last failure, for subscribers that branch on it (the PM-question notice). */
  failureClass?: string;
}

export type AttemptFinishedSubscriber = (event: AttemptFinished) => void | Promise<void>;

/**
 * The bus lives on the plugin instance (the core), like `admittedByCore` in start.ts: tests that build
 * a fresh core get a fresh subscriber list.
 */
const buses = new WeakMap<object, AttemptFinishedSubscriber[]>();

/** Register a reaction to attempt end. Registration order is the run order — it is a contract. */
export function onAttemptFinished(ctx: ServerCore, subscriber: AttemptFinishedSubscriber): void {
  const list = buses.get(ctx) ?? [];
  buses.set(ctx, list);
  list.push(subscriber);
}

/** How many reactions are registered — for the ordering test. */
export function attemptFinishedSubscriberCount(ctx: ServerCore): number {
  return buses.get(ctx)?.length ?? 0;
}

/**
 * Emit to every subscriber in registration order, awaiting each one that returns a promise before the
 * next starts. A reaction that only launches work (the post-merge check, the gate note) returns void
 * and stays fire-and-forget, as it was inline. A throw is logged and does not stop the rest.
 */
export async function emitAttemptFinished(ctx: ServerCore, event: AttemptFinished): Promise<void> {
  const list = buses.get(ctx);
  if (!list) return;
  for (const subscriber of list) {
    try {
      await subscriber(event);
    } catch (cause) {
      ctx.log(`attempt-finished: a reaction failed after ${event.taskId}/${event.attemptId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
}
