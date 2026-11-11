import type { ServerCore } from "../../contracts/server";

/**
 * The live subscription-window facts BB core publishes as `provider/rateLimits/updated` thread events
 * (SMA k_h_statusline). The statusline's last_usage.json is dead since the terminal status line was removed;
 * these events are the feed that replaces it. The latest event of each provider lands in kv, so a hold or a
 * screen answers from facts, never from a file nothing writes.
 */

export const RATE_LIMIT_PREFIX = "rate-limit-windows:";

export type RateLimitWindow = { label: string | null; status: string; resetsAtMs: number | null };
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

/** A blocked window with its reset still ahead holds until the reset; anything else holds nothing. */
export function windowHold(snap: RateLimitSnapshot | null, now: number): string | null {
  if (!snap) return null;
  const blocked = snap.windows.filter((w) => w.status === "blocked" && typeof w.resetsAtMs === "number" && w.resetsAtMs > now);
  if (!blocked.length) return null;
  const soonest = Math.min(...blocked.map((w) => w.resetsAtMs!));
  return `subscription window: ${blocked[0]?.label ?? "window"} is blocked until ${new Date(soonest).toISOString()}`;
}

/** The snapshot shaped as the board's windows (providerUsage's BoardWindows): a blocked window reads as 100%. */
export function snapshotAsBoardWindows(snap: RateLimitSnapshot | null): { at: string | null; windows: Record<string, { utilization: number; resetsAt: string | null }> } {
  if (!snap) return { at: null, windows: {} };
  const windows: Record<string, { utilization: number; resetsAt: string | null }> = {};
  for (const w of snap.windows) {
    const name = w.label?.trim() || "window";
    windows[name] = { utilization: w.status === "blocked" ? 100 : w.status === "warning" ? 90 : 0, resetsAt: typeof w.resetsAtMs === "number" ? new Date(w.resetsAtMs).toISOString() : null };
  }
  return { at: snap.at ? new Date(snap.at).toISOString() : null, windows };
}

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
      const event = (payload as { event?: { type?: unknown; rateLimits?: { kind?: unknown; status?: unknown; providerId?: unknown; windows?: Array<{ label?: unknown; status?: unknown; resetsAtMs?: unknown }> } } })?.event;
      if (event?.type !== "provider/rateLimits/updated") return;
      const rl = event.rateLimits;
      if (rl?.kind !== "subscription-window" || typeof rl.providerId !== "string" || !rl.providerId) return;
      const snap: RateLimitSnapshot = {
        at: Date.now(),
        status: typeof rl.status === "string" ? rl.status : "unknown",
        windows: (rl.windows ?? []).map((w) => ({
          label: typeof w?.label === "string" ? w.label : null,
          status: typeof w?.status === "string" ? w.status : "unknown",
          resetsAtMs: typeof w?.resetsAtMs === "number" ? w.resetsAtMs : null,
        })),
      };
      await ctx.bb.storage.kv.set(`${RATE_LIMIT_PREFIX}${rl.providerId}`, snap as never).catch(() => undefined);
    });
  } catch (cause) {
    ctx.bb.log.info(`Lane Pilot rate-limit watch does not listen: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
