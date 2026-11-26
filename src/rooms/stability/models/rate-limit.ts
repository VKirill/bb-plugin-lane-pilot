export const RATE_LIMIT_PREFIX = "rate-limit-windows:";

export type RateLimitWindow = { label: string | null; providerKey?: string | null; status: string; resetsAtMs: number | null };
export type RateLimitSnapshot = { at: number; status: string; windows: RateLimitWindow[] };

/** One event per provider is stored; it is written only when the value changed or the stored one is over a minute old. */
export const RATE_LIMIT_REWRITE_MS = 60_000;

/** What the board shows from a stored event (only a blocked or warning window whose reset is still ahead): 100% / 90%, marked with the event's time. Nothing known, never an old figure. */
export function snapshotAsBoardWindows(snap: RateLimitSnapshot | null, now: number = Date.now()): { at: string | null; windows: Record<string, { utilization: number; resetsAt: string | null }>; limitEventAt?: string } {
  const windows: Record<string, { utilization: number; resetsAt: string | null }> = {};
  for (const w of snap?.windows ?? []) {
    if ((w.status !== "blocked" && w.status !== "warning") || typeof w.resetsAtMs !== "number" || w.resetsAtMs <= now) continue;
    windows[w.label?.trim() || "window"] = { utilization: w.status === "blocked" ? 100 : 90, resetsAt: new Date(w.resetsAtMs).toISOString() };
  }
  if (!snap || !snap.at || !Object.keys(windows).length) return { at: null, windows: {} };
  const at = new Date(snap.at).toISOString();
  return { at, windows, limitEventAt: at };
}
