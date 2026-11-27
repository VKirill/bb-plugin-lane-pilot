import { isTerminalAttemptState } from "@lane-pilot/contracts";
import { onAttemptChanged } from "../../../storage";
import type { ServerContext } from "../../../platform/server";
import { hasPendingRelayOutcomes } from "../services/relay-runtime";

export interface DeadlineRelay {
  watchedThreads(): Promise<Set<string>>;
  threadSettled(threadId: string): Promise<number>;
  sweep(): Promise<{ fired: number; settled: number }>;
  nextDeadline(): Promise<number | null>;
}

/** Subscribes `mountRelay` to `thread:changed` and terminal-attempt deadlines instead of a background polling loop. */
export function attachRelayDeadlines(
  ctx: ServerContext,
  relay: DeadlineRelay,
  settleMs: number,
  onCommandCount: (threadId: string, count: number) => void,
) {
  const { bb } = ctx;
  const sdk = bb.sdk as unknown as {
    subscribe?: (args: {
      event: "thread:changed";
      callback: (event: { id?: string; metadata?: { statusChange?: { activity?: { activeBackgroundCommandCount?: number } } } }) => void;
    }) => () => void;
  };
  let disposed = false;
  let sweepTimer: ReturnType<typeof setTimeout> | null = null;
  let sweepInFlight: Promise<void> | null = null;
  let nextSweepAt = Number.POSITIVE_INFINITY;
  let watched = new Set<string>();

  const refreshWatched = () =>
    relay.watchedThreads()
      .then((ids) => { watched = ids; })
      .catch((cause: unknown) => ctx.log(`relay: watched threads unreadable: ${cause instanceof Error ? cause.message : String(cause)}`));
  void refreshWatched();

  const armDeadline = (delayMs: number) => {
    // «Ручной режим»: no reminder timers armed while manual.
    if (disposed || ctx.isDisposed() || ctx.manualMode?.on()) return;
    const clamped = Math.max(0, delayMs);
    const due = Date.now() + clamped;
    if (sweepTimer && due >= nextSweepAt) return;
    if (sweepTimer) clearTimeout(sweepTimer);
    nextSweepAt = due;
    sweepTimer = setTimeout(() => { sweepTimer = null; nextSweepAt = Number.POSITIVE_INFINITY; void runSweep(); }, clamped);
    sweepTimer.unref?.();
  };

  const rearmFromState = async () => {
    if (disposed || ctx.isDisposed() || ctx.manualMode?.on()) return;
    let nearest = await relay.nextDeadline().catch(() => null);
    if (ctx.db && hasPendingRelayOutcomes(ctx.db)) {
      const due = Date.now() + settleMs;
      nearest = nearest === null ? due : Math.min(nearest, due);
    }
    if (nearest !== null) armDeadline(Math.min(Math.max(250, nearest - Date.now()), 60 * 60_000));
  };

  const runSweep = (): Promise<void> => {
    if (disposed || ctx.isDisposed()) return Promise.resolve();
    if (ctx.manualMode?.on()) {
      ctx.log("relay: deadline sweep skipped (manual mode)");
      return Promise.resolve();
    }
    if (sweepInFlight) return sweepInFlight;
    const job = relay.sweep().then(async (result) => {
      if (!disposed && !ctx.isDisposed() && (result.fired || result.settled)) ctx.log(`relay: fired ${result.fired}, settled ${result.settled}`);
      await refreshWatched();
      await rearmFromState();
    }, (cause) => {
      if (!disposed && !ctx.isDisposed()) ctx.log(`relay sweep failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }).finally(() => { if (sweepInFlight === job) sweepInFlight = null; });
    return (sweepInFlight = job);
  };

  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = sdk.subscribe?.({
      event: "thread:changed",
      callback: (event) => {
        if (!event.id || disposed || ctx.isDisposed()) return;
        const commands = event.metadata?.statusChange?.activity?.activeBackgroundCommandCount;
        if (typeof commands === "number") onCommandCount(event.id, commands);
        if (ctx.manualMode?.on()) {
          if (watched.has(event.id)) ctx.log(`relay: ${event.id} settled skipped (manual mode)`);
          return;
        }
        if (!watched.has(event.id)) { armDeadline(0); return; }
        void relay.threadSettled(event.id).then((woken) => {
          if (woken) { ctx.log(`relay: ${event.id} settled, woke ${woken}`); void refreshWatched(); }
        }).catch((cause) => ctx.log(`relay event failed: ${cause instanceof Error ? cause.message : String(cause)}`));
      },
    });
  } catch (cause) {
    ctx.log(`relay: no thread events, deadline only: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const unsubAttempt = ctx.db
    ? onAttemptChanged(ctx.db, (_id, state) => {
        if (!disposed && !ctx.isDisposed() && state && isTerminalAttemptState(state)) armDeadline(settleMs);
      })
    : undefined;

  bb.onDispose(() => {
    disposed = true;
    if (sweepTimer) { clearTimeout(sweepTimer); sweepTimer = null; }
    nextSweepAt = Number.POSITIVE_INFINITY;
    unsubscribe?.();
    unsubAttempt?.();
  });

  armDeadline(0);
  return { refreshAfter: <T>(result: T) => { void refreshWatched(); armDeadline(settleMs); return result; } };
}
