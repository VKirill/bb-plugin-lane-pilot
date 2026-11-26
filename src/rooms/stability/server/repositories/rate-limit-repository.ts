import { RATE_LIMIT_PREFIX, type RateLimitSnapshot, type RateLimitWindow } from "../../models/rate-limit";

export async function readRateLimitSnapshot(kv: { get(key: string): Promise<unknown> }, providerId: string): Promise<RateLimitSnapshot | null> {
  const raw = await kv.get(`${RATE_LIMIT_PREFIX}${providerId}`).catch(() => null);
  if (!raw || typeof raw !== "object") return null;
  const row = raw as { at?: unknown; status?: unknown; windows?: unknown };
  return {
    at: typeof row.at === "number" ? row.at : 0,
    status: typeof row.status === "string" ? row.status : "unknown",
    windows: Array.isArray(row.windows) ? (row.windows as RateLimitWindow[]).filter((w) => w && typeof w === "object") : [],
  };
}

export async function saveRateLimitSnapshot(
  kv: { set(key: string, value: unknown): Promise<unknown> },
  providerId: string,
  snap: RateLimitSnapshot,
): Promise<void> {
  await kv.set(`${RATE_LIMIT_PREFIX}${providerId}`, snap as never).catch(() => undefined);
}
