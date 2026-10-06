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

const key = (attemptId: string) => `blocked-by:${attemptId}`;

type Kv = { get(key: string): Promise<unknown>; set(key: string, value: never): Promise<unknown> };

export async function saveBlockedBy(kv: Kv, attemptId: string, blockedBy: BlockedBy): Promise<void> {
  await kv.set(key(attemptId), blockedBy as never);
}

export async function loadBlockedBy(kv: Kv, attemptId: string): Promise<BlockedBy | null> {
  const value = await kv.get(key(attemptId)).catch(() => null);
  return value && typeof value === "object" ? value as BlockedBy : null;
}

/**
 * A blocked task the PM verified by hand (its work is in main or was checked another way): dependents that name it, or
 * any redispatch of it, stop waiting. Keyed by the id without its numeric suffixes, like a dependency's family.
 */
const satisfiedKey = (projectId: string, taskId: string) => `task-satisfied:${projectId}:${taskId.replace(/(\.\d+)+$/, "") || taskId}`;

export async function markTaskSatisfied(kv: Kv, projectId: string, taskId: string, note: string): Promise<void> {
  await kv.set(satisfiedKey(projectId, taskId), { taskId, note, at: Date.now() } as never);
}

export async function isTaskSatisfied(kv: Kv, projectId: string, taskId: string): Promise<boolean> {
  return Boolean(await kv.get(satisfiedKey(projectId, taskId)).catch(() => null));
}
