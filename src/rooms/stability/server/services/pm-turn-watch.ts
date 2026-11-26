import { PM_MAX_TURNS_DEFAULT, PM_TURN_LIMIT_MIN_DEFAULT, type PmTurnEndedEvent } from "../../models/pm-turn";

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
  /** Emits the durable `lp.pm.turn-ended` event when a PM turn finishes or is cut. */
  onTurnEnded?: (event: PmTurnEndedEvent) => void | Promise<void>;
  now: () => number;
  log: (line: string) => void;
};

/**
 * The PM turn watch (SMA m_cf_timeout, m_cf_settings): a turn of a thread that has an open PM run does not end silently —
 * its outcome is named in words (an empty answer, a vendor refusal, the time limit, the turn cap) and kept per thread for
 * the surface that shows it. The two limits are the owner's to set: pm.turn_limit_min and pm.max_turns (tool items, read
 * at turn/started so a change counts from the next turn). Unset means no limit: a PM here is a full agent whose planning
 * turn runs for many minutes and dozens of tool calls, and a built-in cap would cut every one of them.
 */
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
    const reason = outcome.startsWith("предел ходов") ? "max_turns" : "timeout";
    await Promise.resolve(deps.onTurnEnded?.({ threadId, reason, outcome, startedAt: turn.startedAt, endedAt: deps.now() })).catch(() => undefined);
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
    const reason = info?.providerError ? "failed" : "completed";
    const outcome = info?.providerError
      ? `отказ вендора: ${info.providerError.slice(0, 300)}`
      : !turn.assistantText
        ? "пустой ответ"
        : null;
    if (outcome) await name(threadId, outcome);
    await Promise.resolve(deps.onTurnEnded?.({ threadId, reason, outcome, ...(info?.providerError ? { providerError: info.providerError } : {}), startedAt: turn.startedAt, endedAt: deps.now() })).catch(() => undefined);
  }

  /** A turn failed at the provider: the vendor refusal is named with the message it gave. */
  async function turnFailed(threadId: string, message: string | null): Promise<void> {
    const turn = open.get(threadId);
    if (!turn) return;
    open.delete(threadId);
    if (turn.timer) clearTimeout(turn.timer);
    const outcome = `отказ вендора: ${(message ?? "provider error").slice(0, 300)}`;
    await name(threadId, outcome);
    await Promise.resolve(deps.onTurnEnded?.({ threadId, reason: "failed", outcome, providerError: message, startedAt: turn.startedAt, endedAt: deps.now() })).catch(() => undefined);
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
