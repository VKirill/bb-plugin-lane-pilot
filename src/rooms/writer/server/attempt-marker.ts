/** The start marker of an attempt in a thread that already has a history (a leaf module: the writer's continuation imports it, and the usage reading imports half the plugin). */
import { bestEffort, BestEffortLog} from "@lane-pilot/kit";

type Kv = { get(key: string): Promise<unknown>; set(key: string, value: never): Promise<unknown> };

export const startKey = (attemptId: string) => `attempt-usage-start:${attemptId}`;

/** Remembers when the attempt's own turns begin in a thread that already has a history; the first mark stands. */
export async function markAttemptStart(kv: Kv, attemptId: string, at: number, log?: BestEffortLog): Promise<void> {
  const earlier = await kv.get(startKey(attemptId));
  if (typeof earlier === "number") return;
  await bestEffort(log ?? ((message: string) => {}), "writer attempt start marker", kv.set(startKey(attemptId), at as never), undefined);
}

export async function markerOf(kv: Kv, attemptId: string): Promise<number> {
  const value = await kv.get(startKey(attemptId));
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
