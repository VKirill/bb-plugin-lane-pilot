/**
 * Why a task is blocked, as data the PM can act on: who holds what, since when, and when to look again.
 * Text reasons stay for people; this is for the agent and the dispatcher.
 */
export type BlockedBy = {
  kind: "merge-lock" | "serial-queue" | "thread" | "setting" | "human";
  holderTaskId: string | null;
  holderThreadId: string | null;
  holderAttemptId: string | null;
  since: string;
  retryAfterSec: number;
  detail: string | null;
};
