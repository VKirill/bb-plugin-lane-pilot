export const RATE_LIMIT_PREFIX = "rate-limit-windows:";

export type RateLimitWindow = { label: string | null; providerKey?: string | null; status: string; resetsAtMs: number | null };
export type RateLimitSnapshot = { at: number; status: string; windows: RateLimitWindow[] };

/** One event per provider is stored; it is written only when the value changed or the stored one is over a minute old. */
export const RATE_LIMIT_REWRITE_MS = 60_000;


