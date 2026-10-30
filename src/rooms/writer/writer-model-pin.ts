/**
 * The task's writer pair, pinned for the task's whole life (restarts, re-dispatches, retries): the same provider and model
 * keep writing unless a provider failure or a failure-class intervention moves the task down the chain, and the move's
 * reason is recorded (hive H-01, durable implementation ownership). The record lives in the plugin's KV like the Jev pick.
 */
type Kv = { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };

export type WriterPairPin = { providerId: string; model: string; reason: string; at: number };

export const writerPinKey = (runId: string, taskId: string) => `writer-pair:${runId}:${taskId}`;

export async function loadWriterPin(kv: Kv, runId: string, taskId: string): Promise<WriterPairPin | null> {
  const row = await kv.get(writerPinKey(runId, taskId)).catch(() => null) as Partial<WriterPairPin> | null;
  return row && typeof row.providerId === "string" && row.providerId && typeof row.model === "string" && row.model
    ? { providerId: row.providerId, model: row.model, reason: typeof row.reason === "string" ? row.reason : "", at: typeof row.at === "number" ? row.at : 0 }
    : null;
}

/**
 * The pair a writer runs on: written on the first spawn, and again when `reason` moves it (a provider or limit failure,
 * a failure-class intervention — never for a plain retry). Same pair: no write, no new reason.
 */
export async function noteWriterPair(kv: Kv, runId: string, taskId: string, pair: { providerId: string; model: string }, reason: string): Promise<void> {
  const current = await loadWriterPin(kv, runId, taskId);
  if (current && current.providerId === pair.providerId && current.model === pair.model) return;
  await kv.set(writerPinKey(runId, taskId), { ...pair, reason, at: Date.now() }).catch(() => undefined);
}
