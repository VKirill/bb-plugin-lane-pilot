import { bestEffort, type BestEffortLog } from "@lane-pilot/kit";

type Kv = { get(key: string): Promise<unknown>; set(key: string, value: never): Promise<unknown> };
const key = (runId: string, taskId: string) => `writer-question-default:${runId}:${taskId}`;

export async function markAnsweredByDefault(kv: Kv, runId: string, taskId: string, at: number, log?: BestEffortLog): Promise<void> {
  await bestEffort(log ?? ((message: string) => {}), "writer question default mark", kv.set(key(runId, taskId), at as never), undefined);
}

export async function wasAnsweredByDefault(kv: Kv, runId: string, taskId: string): Promise<boolean> {
  return typeof await kv.get(key(runId, taskId)) === "number";
}
