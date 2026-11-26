import { LP_EVENTS } from "@lane-pilot/contracts";
import type { ServerCore } from "../../../contracts/server";
import { sendServiceMessage } from "../../../relay/server";
import { getRun, openRunIdForPmThread } from "../../../storage";
import { PM_MAX_TURNS_DEFAULT, PM_TURN_LIMIT_MIN_DEFAULT, PM_TURN_OUTCOME_PREFIX } from "../../models/pm-turn";
import { PM_MAX_TURNS_KEY, PM_TURN_LIMIT_MIN_KEY } from "../../settings";
import { createPmTurnWatch, type PmTurnWatch } from "../services/pm-turn-watch";
import { installThreadEventFeed, type FeedEvent, type ThreadEventEmitter } from "../services/thread-event-feed";

/**
 * Wires the watch into bb.events: every thread event with a type is offered to it (the watch ignores chats that are
 * not a PM's). The limits are the project settings pm.turn_limit_min and pm.max_turns; unset is no limit.
 */
export function mountPmTurnWatch(ctx: ServerCore, options?: { emitEvent?: ThreadEventEmitter }): PmTurnWatch | null {
  const { bb, db } = ctx;
  const events = (bb as unknown as { events?: { on?: (name: string, handler: (payload: unknown) => unknown) => void } }).events;
  const watch = createPmTurnWatch({
    isPmThread: async (threadId) => openRunIdForPmThread(db, threadId) !== null,
    limits: async (threadId) => {
      const runId = openRunIdForPmThread(db, threadId);
      const projectId = runId ? getRun(db, runId)?.project_id : null;
      const settings = projectId ? await ctx.effectiveProjectSettings(projectId).then((result) => result.values as Record<string, unknown>, () => ({} as Record<string, unknown>)) : {};
      const num = (key: string, fallback: number) => { const value = Number(settings[key] ?? NaN); return Number.isFinite(value) && value >= 1 ? value : fallback; };
      return { turnLimitMin: num(PM_TURN_LIMIT_MIN_KEY, PM_TURN_LIMIT_MIN_DEFAULT), maxTurns: num(PM_MAX_TURNS_KEY, PM_MAX_TURNS_DEFAULT) };
    },
    stop: async (threadId) => bb.sdk.threads.stop({ threadId } as never),
    // The outcome goes to the log and the kept record, not into the chat: a plugin fact in a PM chat wakes the PM
    // (the owner's rule of 2026-10-31). Only a cut the owner's own limit made is said there, so the stop has a reason.
    tell: async (threadId, text) => { if (/^(ход не уложился|предел ходов)/.test(text)) await sendServiceMessage(bb as never, { threadId, mode: "queue-if-active", text: `Lane Pilot: ${text}` }); },
    record: async (threadId, outcome) => { await bb.storage.kv.set(`${PM_TURN_OUTCOME_PREFIX}${threadId}`, { outcome, at: Date.now() } as never); },
    onTurnEnded: async (evt) => {
      if (!options?.emitEvent) return;
      const runId = openRunIdForPmThread(db, evt.threadId);
      const projectId = runId ? getRun(db, runId)?.project_id ?? undefined : undefined;
      await options.emitEvent(LP_EVENTS.PM_TURN_ENDED, {
        eventId: `${LP_EVENTS.PM_TURN_ENDED}:${evt.threadId}:${evt.startedAt}`,
        eventKey: evt.threadId,
        threadId: evt.threadId,
        ...(projectId ? { projectId } : {}),
        ...(runId ? { runId } : {}),
        reason: evt.reason,
        outcome: evt.outcome,
        ...(evt.providerError ? { providerError: evt.providerError } : {}),
      });
    },
    now: () => Date.now(),
    log: (line) => bb.log.info(line),
  });
  if (!events || typeof events.on !== "function") return watch;
  const on = (name: string, handler: (payload: never) => Promise<void>) => {
    try { events.on!(name, async (payload) => { if (!ctx.isDisposed()) await handler(payload as never); }); }
    catch (cause) { bb.log.info(`Lane Pilot PM turn watch does not listen to ${name}: ${cause instanceof Error ? cause.message : String(cause)}`); }
  };
  // experimental_thread.events carries only {thread, sequence}: the feed reads the event log for the turn lifecycle
  // rows (0.1.575 — the payload never held the event itself).
  const feed = installThreadEventFeed(ctx, options?.emitEvent ? { emitEvent: options.emitEvent } : undefined);
  feed.add({
    types: new Set(["turn/started", "item/completed", "turn/completed"]),
    handle: async (threadId, rows) => {
      for (const row of rows) {
        if (ctx.isDisposed()) return;
        if (row.type === "turn/started") await watch.turnStarted(threadId);
        else if (row.type === "item/completed") await watch.itemCompleted(threadId, itemTypeOf(row));
        else if (row.type === "turn/completed") await watch.turnCompleted(threadId, completedInfo(row));
      }
    },
  });
  on("turn.failed", async (payload: { threadId?: unknown; errorInfo?: unknown }) => {
    if (typeof payload?.threadId !== "string") return;
    await watch.turnFailed(payload.threadId, failureText(payload.errorInfo));
  });
  return watch;
}

/** The item type an item/completed row reports (data.item.type in the stored event). */
function itemTypeOf(row: FeedEvent): string {
  const item = (row.data as { item?: { type?: unknown } } | null)?.item;
  return typeof item?.type === "string" ? item.type : "";
}

/** A failed turn's own error text (data.error.message), when the provider gave one. */
function completedInfo(row: FeedEvent): { providerError?: string | null } | undefined {
  const error = (row.data as { error?: { message?: unknown } } | null)?.error;
  return typeof error?.message === "string" ? { providerError: error.message } : undefined;
}

/** turn.failed's structured ProviderErrorInfo — category, provider code and HTTP status, no message field. */
function failureText(errorInfo: unknown): string | null {
  if (!errorInfo || typeof errorInfo !== "object") return null;
  const info = errorInfo as { category?: unknown; providerCode?: unknown; httpStatusCode?: unknown };
  const parts = [info.category, info.providerCode, info.httpStatusCode].filter((part) => typeof part === "string" || typeof part === "number");
  return parts.length ? parts.join(" ") : null;
}
