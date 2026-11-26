import { RATE_LIMIT_REWRITE_MS, type RateLimitSnapshot } from "../../models/rate-limit";
import { readRateLimitSnapshot, saveRateLimitSnapshot } from "../repositories/rate-limit-repository";

/** Stores a new subscription-window snapshot if it changed or the stored record is stale. Returns whether it updated. */
export async function recordRateLimitSnapshot(
  kv: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown> },
  providerId: string,
  snap: RateLimitSnapshot,
): Promise<boolean> {
  const stored = await readRateLimitSnapshot(kv, providerId);
  const same = stored && JSON.stringify({ status: stored.status, windows: stored.windows }) === JSON.stringify({ status: snap.status, windows: snap.windows });
  if (same && snap.at - stored.at < RATE_LIMIT_REWRITE_MS) return false;
  await saveRateLimitSnapshot(kv, providerId, snap);
  return true;
}
