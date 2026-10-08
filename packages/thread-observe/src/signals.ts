import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * Thread signals: BB tells the plugin when a thread's state changes (`bb.events.on`), so a watcher sleeps until then
 * instead of reading the thread every second or two. The events only wake the watcher; what a thread's state means is
 * still decided by `decideThreadCompletion` from a fresh read, and a slow fallback poll covers a lost event.
 */

/** A watcher that heard nothing for this long reads the thread anyway. */
export const SIGNAL_FALLBACK_MS = 20_000;

export type ThreadSignalReason =
  | "thread.idle" | "thread.failed" | "thread.archived" | "thread.deleted" | "experimental_thread.events" | "message.cancelled";

export type ThreadSignalHub = {
  /** Take before reading the thread: a signal that arrives after the mark but before `wait` is not lost. */
  mark(): number;
  notify(threadId: string, reason: ThreadSignalReason): void;
  /** Resolves at the first signal for the thread after `mark`, at `fallbackMs`, or when `signal` aborts. */
  wait(threadId: string, mark: number, fallbackMs?: number, signal?: AbortSignal): Promise<"signal" | "timeout" | "aborted">;
  /** A reload ends the instance: every sleeper wakes at once, and later sleeps fall back to one second. */
  dispose(): void;
  readonly fallbackMs: number;
  readonly stats: { signals: number; wakes: number; timeouts: number; lastSignalAt: number | null };
};

export function createThreadSignalHub(fallbackMs = SIGNAL_FALLBACK_MS): ThreadSignalHub {
  let seq = 0;
  const lastSignal = new Map<string, number>();
  const waiters = new Map<string, Set<() => void>>();
  const stats = { signals: 0, wakes: 0, timeouts: 0, lastSignalAt: null as number | null };
  let disposed = false;
  return {
    fallbackMs,
    stats,
    mark: () => seq,
    dispose() {
      disposed = true;
      for (const set of [...waiters.values()]) for (const wake of [...set]) wake();
    },
    notify(threadId) {
      stats.signals++;
      stats.lastSignalAt = Date.now();
      lastSignal.set(threadId, ++seq);
      // A thread signalled long ago has no waiter that could still hold an older mark.
      if (lastSignal.size > 4000) for (const key of [...lastSignal.keys()].slice(0, 2000)) if (!waiters.has(key)) lastSignal.delete(key);
      for (const wake of [...(waiters.get(threadId) ?? [])]) wake();
    },
    wait(threadId, mark, ms = fallbackMs, signal) {
      if ((lastSignal.get(threadId) ?? 0) > mark) { stats.wakes++; return Promise.resolve("signal"); }
      if (signal?.aborted) return Promise.resolve("aborted");
      return new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const set = waiters.get(threadId) ?? new Set<() => void>();
        waiters.set(threadId, set);
        const done = (result: "signal" | "timeout" | "aborted") => {
          if (timer) clearTimeout(timer);
          set.delete(wake);
          if (!set.size) waiters.delete(threadId);
          signal?.removeEventListener("abort", onAbort);
          if (result === "signal") stats.wakes++; else if (result === "timeout") stats.timeouts++;
          resolve(result);
        };
        const wake = () => done("signal");
        const onAbort = () => done("aborted");
        set.add(wake);
        timer = setTimeout(() => done("timeout"), Math.max(1, disposed ? Math.min(ms, 1000) : ms));
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

const hubs = new WeakMap<object, ThreadSignalHub>();

type EventsApi = { on?: (event: string, handler: (payload: unknown) => void) => void };

function threadIdOf(payload: unknown): string | null {
  const thread = payload && typeof payload === "object" ? Reflect.get(payload, "thread") : undefined;
  const id = thread && typeof thread === "object" ? Reflect.get(thread, "id") : undefined;
  return typeof id === "string" && id ? id : null;
}

/**
 * Subscribes the plugin to BB's thread lifecycle events once and returns the hub its watchers sleep on. Null when BB
 * offers no events (an older host, a test host) or `LANE_PILOT_THREAD_SIGNALS=0`: watchers then poll as before.
 * Call from the plugin factory, where `bb.events.on` is legal.
 */
export function installThreadSignals(bb: BbPluginApi, fallbackMs = SIGNAL_FALLBACK_MS): ThreadSignalHub | null {
  const existing = hubs.get(bb);
  if (existing) return existing;
  if (process.env.LANE_PILOT_THREAD_SIGNALS === "0") return null;
  const events = (bb as unknown as { events?: EventsApi }).events;
  if (!events || typeof events.on !== "function") return null;
  const hub = createThreadSignalHub(fallbackMs);
  const listen = (name: ThreadSignalReason, accept: (payload: unknown) => boolean = () => true) => {
    events.on!(name, (payload) => {
      const threadId = threadIdOf(payload);
      if (threadId && accept(payload)) hub.notify(threadId, name);
    });
  };
  try {
    listen("thread.idle");
    listen("thread.failed");
    listen("thread.archived");
    listen("thread.deleted");
    // Debounced to once a second per thread: while a turn runs the status is "active" and nothing here can finish a wait,
    // so only the other states wake a watcher (a rejected turn and a failed start show up this way).
    listen("experimental_thread.events", (payload) => {
      const thread = Reflect.get(payload as object, "thread");
      return thread && typeof thread === "object" && Reflect.get(thread, "status") !== "active";
    });
  } catch {
    return null;
  }
  hubs.set(bb, hub);
  (bb as unknown as { onDispose?: (fn: () => void) => void }).onDispose?.(() => hub.dispose());
  return hub;
}

export function threadSignalHub(bb: unknown): ThreadSignalHub | null {
  return bb && typeof bb === "object" ? hubs.get(bb) ?? null : null;
}

/**
 * One step of a watcher's loop: sleeps `pollMs` as before, or, when the plugin has the hub, until BB reports a change in
 * the thread (or the fallback poll). `mark` comes from `threadWatchMark` taken before the thread was read.
 * `deadlineAt` is the waiter's own deadline (epoch ms): the sleep never runs past it, so a short probe is not stretched to the
 * 20 s fallback. `maxMs` caps one sleep for a waiter that has to look again sooner (a stop check that BB's events do not carry).
 */
export async function sleepUntilThreadSignal(bb: unknown, threadId: string, mark: number | null, pollMs: number, signal?: AbortSignal, limits: { deadlineAt?: number; maxMs?: number } = {}): Promise<void> {
  const hub = threadSignalHub(bb);
  const remaining = limits.deadlineAt === undefined || !Number.isFinite(limits.deadlineAt) ? Infinity : Math.max(0, limits.deadlineAt - Date.now());
  if (!hub || mark === null) { await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining))); return; }
  await hub.wait(threadId, mark, Math.min(hub.fallbackMs, remaining, limits.maxMs ?? Infinity), signal);
}

/** Take this before reading the thread; null when the plugin has no hub (the sleep then polls). */
export const threadWatchMark = (bb: unknown): number | null => threadSignalHub(bb)?.mark() ?? null;
