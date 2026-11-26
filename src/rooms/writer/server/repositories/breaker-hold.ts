import type { BreakerEntry, BreakerOutcome, ProviderBreaker } from "@lane-pilot/resilience";

export const PROVIDER_BREAKER_KV_KEY = "writer-provider-breaker:v1";

type KvLike = {
  get<T = unknown>(key: string): Promise<T | null | undefined>;
  set(key: string, value: unknown): Promise<unknown>;
};

/** Loads persisted provider-breaker holds into `breaker` after a hub restart. */
export async function restoreProviderBreaker(
  kv: KvLike | undefined,
  breaker: Partial<Pick<ProviderBreaker, "restore">> | undefined,
  now = Date.now(),
): Promise<void> {
  if (!kv || typeof breaker?.restore !== "function") return;
  const saved = await kv.get<Record<string, Partial<BreakerEntry>>>(PROVIDER_BREAKER_KV_KEY).catch(() => null);
  if (saved) breaker.restore(saved, now);
}

/** Persists open provider-breaker holds so a hub restart keeps `wakeAt` deadlines intact. */
export async function saveProviderBreaker(
  kv: KvLike | undefined,
  breaker: Partial<Pick<ProviderBreaker, "entries">> | undefined,
): Promise<void> {
  if (!kv || typeof breaker?.entries !== "function") return;
  await kv.set(PROVIDER_BREAKER_KV_KEY, breaker.entries()).catch(() => undefined);
}

/** Records a breaker outcome and persists open holds (`until` becomes the durable `wakeAt`). */
export async function recordAndPersistBreaker(
  kv: KvLike | undefined,
  breaker: Pick<ProviderBreaker, "record"> & Partial<Pick<ProviderBreaker, "entries">>,
  key: string,
  outcome: BreakerOutcome,
  now = Date.now(),
  until?: number,
): Promise<void> {
  breaker.record(key, outcome, now, until);
  await saveProviderBreaker(kv, breaker);
}
