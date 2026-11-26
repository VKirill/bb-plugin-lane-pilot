import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { LanePilotDatabase } from "../../../storage";
import { pluginStopped } from "../../../contracts/errors";
import type { ServerCore } from "../../../contracts/server";
import { stringAt, valueAt } from "@lane-pilot/kit";
import { DAY_MS, TOKEN_USAGE_LAST_SYNC_KEY, type TokenUsageRebuildReset } from "../../models/token-usage";
import { lookupThreadCursorMeta, resetTokenUsageForRebuild } from "../repositories/token-usage-repository";
import { foldThreadEvents, syncTokenUsage } from "../services/token-usage";
import { emitTokenUsageAdded } from "../services/token-usage-bus";

export { TOKEN_USAGE_LAST_SYNC_KEY };

function payloadThreadMeta(payload: unknown): { threadId: string; projectId?: string; providerId?: string } | null {
  const thread = valueAt(payload, "thread");
  const threadId = stringAt(payload, "threadId") ?? stringAt(thread, "id") ?? (typeof thread === "string" ? thread : undefined);
  if (!threadId) return null;
  const projectId = stringAt(thread, "projectId");
  const providerId = stringAt(thread, "providerId");
  return { threadId, ...(projectId ? { projectId } : {}), ...(providerId ? { providerId } : {}) };
}

type FoldFn = (
  ctx: { bb: BbPluginApi; db: LanePilotDatabase; isDisposed?: () => boolean },
  thread: { id: string; projectId: string; providerId: string },
  options: { now: number; since: number },
) => Promise<{ tokensAdded: number }>;

type ThreadMetaLookup = (db: LanePilotDatabase, threadId: string) => { project_id: string; provider_id: string; last_provider?: string } | undefined;

/**
 * Fold newly written token-usage events for each thread as turn/thread events arrive (`thread.idle`, `thread.failed`,
 * `turn.failed`, `experimental_thread.events`), coalesced sequentially per thread so concurrent wakes never race the cursor.
 */
export function mountTokenUsageEvents(
  ctx: { bb: BbPluginApi; db: LanePilotDatabase; isDisposed?: () => boolean },
  deps: { lookupThreadMeta: ThreadMetaLookup; foldThreadEvents: FoldFn; isStopped?: (cause: unknown) => boolean },
): void {
  const inFlight = new Set<string>();
  const pending = new Set<string>();
  const threadMetaCache = new Map<string, { projectId: string; providerId: string }>();

  const foldOne = async (hint: { threadId: string; projectId?: string; providerId?: string }) => {
    if (inFlight.has(hint.threadId)) { pending.add(hint.threadId); return; }
    inFlight.add(hint.threadId);
    try {
      do {
        pending.delete(hint.threadId);
        if (ctx.isDisposed?.()) break;
        let meta = threadMetaCache.get(hint.threadId);
        if (!meta) {
          const cursor = deps.lookupThreadMeta(ctx.db, hint.threadId);
          if (hint.projectId || cursor?.project_id || cursor?.last_provider || cursor?.provider_id) {
            meta = { projectId: hint.projectId || cursor?.project_id || "", providerId: hint.providerId || cursor?.last_provider || cursor?.provider_id || "" };
          } else {
            const loaded = await ctx.bb.sdk?.threads?.get?.({ threadId: hint.threadId }).catch(() => null);
            meta = { projectId: hint.projectId || stringAt(loaded, "projectId") || "", providerId: hint.providerId || stringAt(loaded, "providerId") || "" };
          }
          if (meta.projectId || meta.providerId) threadMetaCache.set(hint.threadId, meta);
        }
        const now = Date.now();
        const folded = await deps.foldThreadEvents(ctx, { id: hint.threadId, projectId: meta.projectId, providerId: meta.providerId }, { now, since: now - 90 * DAY_MS });
        if (folded.tokensAdded > 0 && !ctx.isDisposed?.()) {
          await ctx.bb.storage.kv.set(TOKEN_USAGE_LAST_SYNC_KEY, now).catch(() => undefined);
          emitTokenUsageAdded(ctx.bb);
        }
      } while (pending.has(hint.threadId));
    } catch (cause) {
      if (!deps.isStopped?.(cause)) ctx.bb.log?.warn?.(`Lane Pilot token usage fold failed for ${hint.threadId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      inFlight.delete(hint.threadId);
    }
  };

  const events = (ctx.bb as unknown as { events?: { on?: (name: string, fn: (payload: unknown) => unknown) => void } }).events;
  if (!events || typeof events.on !== "function") return;
  for (const eventName of ["thread.idle", "thread.failed", "turn.failed", "experimental_thread.events"]) {
    try {
      events.on(eventName, (payload) => {
        if (ctx.isDisposed?.()) return;
        const hint = payloadThreadMeta(payload);
        if (hint) void foldOne(hint);
      });
    } catch { /* older BB may omit experimental_thread.events; turn-end events and ready replay cover it */ }
  }
}

export function attachTokenUsage(ctx: Pick<ServerCore, "bb" | "db"> & Partial<Pick<ServerCore, "isDisposed">>): {
  start: (sinceDays?: number) => boolean;
  rebuild: (sinceDays?: number) => (TokenUsageRebuildReset & { started: true; startedAt: number }) | { started: false };
} {
  let running = false;
  const start = (sinceDays = 90) => {
    if (running || ctx.isDisposed?.()) return false;
    running = true;
    void syncTokenUsage(ctx, { sinceDays })
      .catch((cause) => {
        if (!pluginStopped(cause)) ctx.bb.log.warn(`Lane Pilot token usage sync failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      })
      .finally(() => { running = false; });
    return true;
  };
  mountTokenUsageEvents(ctx, {
    lookupThreadMeta: lookupThreadCursorMeta,
    foldThreadEvents,
    isStopped: pluginStopped,
  });
  const rebuild = (sinceDays = 90) => {
    if (running) return { started: false as const };
    const startedAt = Date.now();
    const reset = resetTokenUsageForRebuild(ctx.db, startedAt);
    start(sinceDays);
    return { started: true as const, startedAt, ...reset };
  };
  // Replay cursors once on ready so events written while stopped/reloading are folded, then follow live turn events.
  start(90);
  return { start, rebuild };
}
