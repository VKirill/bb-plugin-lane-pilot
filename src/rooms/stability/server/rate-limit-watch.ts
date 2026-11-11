import type { ServerCore } from "../../contracts/server";

/**
 * The live subscription-window facts BB core publishes as `provider/rateLimits/updated` thread events
 * (SMA k_h_statusline). The statusline's last_usage.json is dead since the terminal status line was removed;
 * these events are the feed that replaces it. The latest event of each provider lands in kv, so a hold or a
 * screen answers from facts, never from a file nothing writes.
 */

export const RATE_LIMIT_PREFIX = "rate-limit-windows:";

export type RateLimitWindow = { label: string | null; providerKey?: string | null; status: string; resetsAtMs: number | null };
export type RateLimitSnapshot = { at: number; status: string; windows: RateLimitWindow[] };

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

/** One event per provider is stored; it is written only when the value changed or the stored one is over a minute old. */
export const RATE_LIMIT_REWRITE_MS = 60_000;

/**
 * Wires the watch into bb.events, like the PM turn watch: a subscription-window event of any thread refreshes
 * its provider's record (the figure is the account's, not the thread's). No windows stored → nothing changes.
 */
export function mountRateLimitWatch(ctx: ServerCore): void {
  const events = (ctx.bb as unknown as { events?: { on?: (name: string, handler: (payload: unknown) => unknown) => void } }).events;
  if (!events || typeof events.on !== "function") return;
  try {
    events.on("experimental_thread.events", async (payload: unknown) => {
      if (ctx.isDisposed()) return;
      const event = (payload as { event?: { type?: unknown; rateLimits?: { kind?: unknown; status?: unknown; providerId?: unknown; windows?: Array<{ label?: unknown; providerKey?: unknown; status?: unknown; resetsAtMs?: unknown }> } } })?.event;
      if (event?.type !== "provider/rateLimits/updated") return;
      const rl = event.rateLimits;
      if (rl?.kind !== "subscription-window" || typeof rl.providerId !== "string" || !rl.providerId) return;
      const snap: RateLimitSnapshot = {
        at: Date.now(),
        status: typeof rl.status === "string" ? rl.status : "unknown",
        windows: (rl.windows ?? []).map((w) => ({
          label: typeof w?.label === "string" ? w.label : null,
          providerKey: typeof w?.providerKey === "string" ? w.providerKey : null,
          status: typeof w?.status === "string" ? w.status : "unknown",
          resetsAtMs: typeof w?.resetsAtMs === "number" ? w.resetsAtMs : null,
        })),
      };
      const key = `${RATE_LIMIT_PREFIX}${rl.providerId}`;
      const stored = await readRateLimitSnapshot(ctx.bb.storage.kv as never, rl.providerId);
      const same = stored && JSON.stringify({ status: stored.status, windows: stored.windows }) === JSON.stringify({ status: snap.status, windows: snap.windows });
      if (same && snap.at - stored.at < RATE_LIMIT_REWRITE_MS) return;
      await ctx.bb.storage.kv.set(key, snap as never).catch(() => undefined);
    });
  } catch (cause) {
    ctx.bb.log.info(`Lane Pilot rate-limit watch does not listen: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
