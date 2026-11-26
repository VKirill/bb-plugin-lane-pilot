import type { ServerCore } from "../../../contracts/server";
import type { RateLimitSnapshot } from "../../models/rate-limit";
import { recordRateLimitSnapshot } from "../services/rate-limit-watch";
import { installThreadEventFeed } from "../services/thread-event-feed";

/**
 * The live subscription-window facts BB core publishes as `provider/rateLimits/updated` thread events
 * (SMA k_h_statusline). The statusline's last_usage.json is dead since the terminal status line was removed;
 * these events are the feed that replaces it. The latest event of each provider lands in kv, so a hold or a
 * screen answers from facts, never from a file nothing writes.
 */

/**
 * Wires the watch into bb.events, like the PM turn watch: a subscription-window event of any thread refreshes
 * its provider's record (the figure is the account's, not the thread's). No windows stored → nothing changes.
 */
export function mountRateLimitWatch(ctx: ServerCore, options?: { onUpdated?: (providerId: string) => void }): void {
  const events = (ctx.bb as unknown as { events?: { on?: (name: string, handler: (payload: unknown) => unknown) => void } }).events;
  if (!events || typeof events.on !== "function") return;
  // experimental_thread.events carries only {thread, sequence}: the feed reads provider/rateLimits/updated rows
  // out of the event log (0.1.575 — the payload never held the event itself).
  const feed = installThreadEventFeed(ctx);
  feed.add({
    types: new Set(["provider/rateLimits/updated"]),
    handle: async (_threadId, rows) => {
      for (const row of rows) {
        if (ctx.isDisposed()) return;
        const rl = (row.data as { rateLimits?: { kind?: unknown; status?: unknown; providerId?: unknown; windows?: Array<{ label?: unknown; providerKey?: unknown; status?: unknown; resetsAtMs?: unknown }> } } | null)?.rateLimits;
        if (rl?.kind !== "subscription-window" || typeof rl.providerId !== "string" || !rl.providerId) continue;
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
        const updated = await recordRateLimitSnapshot(ctx.bb.storage.kv as never, rl.providerId, snap);
        if (!updated) continue;
        try { options?.onUpdated?.(rl.providerId); } catch { /* listener errors must not stop rate-limit ingestion */ }
      }
    },
  });
}
