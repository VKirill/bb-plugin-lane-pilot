/**
 * The PM turn watch (SMA m_cf_timeout, m_cf_settings): a turn of a thread that has an open PM run does not end silently —
 * its outcome is named in words (an empty answer, a vendor refusal, the time limit, the turn cap) and kept per thread for
 * the surface that shows it. The two limits are the owner's to set: pm.turn_limit_min and pm.max_turns (tool items, read
 * at turn/started so a change counts from the next turn). Unset means no limit: a PM here is a full agent whose planning
 * turn runs for many minutes and dozens of tool calls, and a built-in cap would cut every one of them.
 */
export const PM_TURN_LIMIT_MIN_DEFAULT = 0;
export const PM_MAX_TURNS_DEFAULT = 0;
export const PM_TURN_OUTCOME_PREFIX = "pm-turn:outcome:";

type OpenTurn = { startedAt: number; limitMs: number; maxTurns: number; items: number; assistantText: boolean; timer: ReturnType<typeof setTimeout> | null };

export type PmTurnWatchDeps = {
  /** The thread has an open PM run (a writer thread is ignored). */
  isPmThread: (threadId: string) => Promise<boolean>;
  /** The limits in force for a new turn of this thread; read at turn/started so a change applies from the next turn. */
  limits: (threadId: string) => Promise<{ turnLimitMin: number; maxTurns: number }>;
  stop: (threadId: string) => Promise<unknown>;
  /** Says the named outcome to the person, in his own chat. */
  tell: (threadId: string, text: string) => Promise<unknown>;
  /** Keeps the last named outcome per thread for the surface that shows it. */
  record: (threadId: string, outcome: string) => Promise<unknown>;
  now: () => number;
  log: (line: string) => void;
};

export function createPmTurnWatch(deps: PmTurnWatchDeps) {
  const open = new Map<string, OpenTurn>();

  async function name(threadId: string, outcome: string): Promise<void> {
    await deps.record(threadId, outcome).catch(() => undefined);
    await deps.tell(threadId, outcome).catch((cause: unknown) => deps.log(`Lane Pilot could not name the PM turn outcome in ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`));
    deps.log(`Lane Pilot PM turn ${threadId}: ${outcome}`);
  }

  async function cut(threadId: string, outcome: string): Promise<void> {
    const turn = open.get(threadId);
    if (!turn) return;
    open.delete(threadId);
    if (turn.timer) clearTimeout(turn.timer);
    await name(threadId, outcome);
    await deps.stop(threadId).catch((cause: unknown) => deps.log(`Lane Pilot could not stop PM turn ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`));
  }

  async function turnStarted(threadId: string): Promise<void> {
    if (!await deps.isPmThread(threadId).catch(() => false)) return;
    const limits = await deps.limits(threadId).catch(() => ({ turnLimitMin: PM_TURN_LIMIT_MIN_DEFAULT, maxTurns: PM_MAX_TURNS_DEFAULT }));
    const turn: OpenTurn = { startedAt: deps.now(), limitMs: limits.turnLimitMin > 0 ? limits.turnLimitMin * 60_000 : 0, maxTurns: limits.maxTurns > 0 ? limits.maxTurns : 0, items: 0, assistantText: false, timer: null };
    const previous = open.get(threadId);
    if (previous?.timer) clearTimeout(previous.timer);
    open.set(threadId, turn);
    if (!turn.limitMs) return;
    turn.timer = setTimeout(() => { void cut(threadId, `ход не уложился в ${limits.turnLimitMin} минут`); }, turn.limitMs);
    turn.timer.unref?.();
  }

  /** An item of the open turn: a completed action item counts toward the cap; assistant text marks the answer non-empty. */
  async function itemCompleted(threadId: string, itemType: string): Promise<void> {
    const turn = open.get(threadId);
    if (!turn) return;
    // The same two action items the writer turn ceiling counts (writer-silence callSignatureOf): toolCall and
    // commandExecution. fileChange is the artifact of a call, not a call — it does not count.
    if (itemType === "toolCall" || itemType === "commandExecution") turn.items += 1;
    else if (/assistant|message|text/i.test(itemType)) turn.assistantText = true;
    if (turn.maxTurns && turn.items > turn.maxTurns) await cut(threadId, `предел ходов: ${turn.maxTurns}`);
  }

  /** The turn ended: name what it left — an empty answer, a vendor refusal; nothing when the answer spoke. */
  async function turnCompleted(threadId: string, info?: { providerError?: string | null }): Promise<void> {
    const turn = open.get(threadId);
    if (!turn) return;
    open.delete(threadId);
    if (turn.timer) clearTimeout(turn.timer);
    if (info?.providerError) await name(threadId, `отказ вендора: ${info.providerError.slice(0, 300)}`);
    else if (!turn.assistantText) await name(threadId, "пустой ответ");
  }

  /** A turn failed at the provider: the vendor refusal is named with the message it gave. */
  async function turnFailed(threadId: string, message: string | null): Promise<void> {
    const turn = open.get(threadId);
    if (!turn) return;
    open.delete(threadId);
    if (turn.timer) clearTimeout(turn.timer);
    await name(threadId, `отказ вендора: ${(message ?? "provider error").slice(0, 300)}`);
  }

  /** The sweeper's pass over open turns: cut the ones past their time limit (a reload loses the timers, not the turns). */
  async function sweep(now: number): Promise<string[]> {
    const cutIds: string[] = [];
    for (const [threadId, turn] of [...open]) {
      if (turn.limitMs && now - turn.startedAt >= turn.limitMs) { await cut(threadId, `ход не уложился в ${Math.round(turn.limitMs / 60_000)} минут`); cutIds.push(threadId); }
    }
    return cutIds;
  }

  return { turnStarted, itemCompleted, turnCompleted, turnFailed, sweep, open: (threadId: string) => open.get(threadId) };
}

export type PmTurnWatch = ReturnType<typeof createPmTurnWatch>;

import type { ServerCore } from "../../contracts/server";
import { getRun, openRunIdForPmThread } from "../../storage";
import { sendServiceMessage } from "../../relay/server";
import { installThreadEventFeed, type FeedEvent } from "./thread-event-feed";

/**
 * Wires the watch into bb.events: every thread event with a type is offered to it (the watch ignores chats that are
 * not a PM's). The limits are the project settings pm.turn_limit_min and pm.max_turns; unset is no limit.
 */
export function mountPmTurnWatch(ctx: ServerCore): PmTurnWatch | null {
  const { bb, db } = ctx;
  const events = (bb as unknown as { events?: { on?: (name: string, handler: (payload: unknown) => unknown) => void } }).events;
  const watch = createPmTurnWatch({
    isPmThread: async (threadId) => openRunIdForPmThread(db, threadId) !== null,
    limits: async (threadId) => {
      const runId = openRunIdForPmThread(db, threadId);
      const projectId = runId ? getRun(db, runId)?.project_id : null;
      const settings = projectId ? await ctx.effectiveProjectSettings(projectId).then((result) => result.values as Record<string, unknown>, () => ({} as Record<string, unknown>)) : {};
      const num = (key: string, fallback: number) => { const value = Number(settings[key] ?? NaN); return Number.isFinite(value) && value >= 1 ? value : fallback; };
      return { turnLimitMin: num("pm.turn_limit_min", PM_TURN_LIMIT_MIN_DEFAULT), maxTurns: num("pm.max_turns", PM_MAX_TURNS_DEFAULT) };
    },
    stop: async (threadId) => bb.sdk.threads.stop({ threadId } as never),
    // The outcome goes to the log and the kept record, not into the chat: a plugin fact in a PM chat wakes the PM
    // (the owner's rule of 2026-10-31). Only a cut the owner's own limit made is said there, so the stop has a reason.
    tell: async (threadId, text) => { if (/^(ход не уложился|предел ходов)/.test(text)) await sendServiceMessage(bb as never, { threadId, mode: "queue-if-active", text: `Lane Pilot: ${text}` }); },
    record: async (threadId, outcome) => { await bb.storage.kv.set(`${PM_TURN_OUTCOME_PREFIX}${threadId}`, { outcome, at: Date.now() } as never); },
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
  const feed = installThreadEventFeed(ctx);
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
