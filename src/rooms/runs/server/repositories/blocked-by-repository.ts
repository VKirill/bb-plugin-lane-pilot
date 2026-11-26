import { taskRedispatchBase } from "@lane-pilot/contracts";
import type { BlockedBy } from "../../models/blocked-by";

const key = (attemptId: string) => `blocked-by:${attemptId}`;

type Kv = { get(key: string): Promise<unknown>; set(key: string, value: never): Promise<unknown> };

export async function saveBlockedBy(kv: Kv, attemptId: string, blockedBy: BlockedBy): Promise<void> {
  await kv.set(key(attemptId), blockedBy as never);
}

export async function loadBlockedBy(kv: Kv, attemptId: string): Promise<BlockedBy | null> {
  const value = await kv.get(key(attemptId));
  return value && typeof value === "object" ? value as BlockedBy : null;
}

/**
 * A blocked task the PM verified by hand (its work is in main or was checked another way): dependents that name it, or
 * any redispatch of it, stop waiting. Keyed by the id without its numeric suffixes, like a dependency's family.
 */
const satisfiedKey = (projectId: string, taskId: string) => `task-satisfied:${projectId}:${taskRedispatchBase(taskId)}`;

export async function markTaskSatisfied(kv: Kv, projectId: string, taskId: string, note: string): Promise<void> {
  await kv.set(satisfiedKey(projectId, taskId), { taskId, note, at: Date.now() } as never);
}

export async function isTaskSatisfied(kv: Kv, projectId: string, taskId: string): Promise<boolean> {
  return Boolean(await kv.get(satisfiedKey(projectId, taskId)));
}
