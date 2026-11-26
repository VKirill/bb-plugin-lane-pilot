import type { WorkflowEngine } from "./engine";
import { settleDue } from "./engine-resume";

/** Longest sleep: the clock also stamps the outage beat, so it never sleeps past one beat. */
export const CLOCK_BEAT_MS = 60_000;
/** A timer that fires later than this behind its target is drift worth a warning. */
export const CLOCK_DRIFT_WARN_MS = 5_000;
/** Overdue deadlines fired per tick; the rest follow at once on the re-arm, so an outage does not fire a burst. */
export const DEFAULT_OVERDUE_CAP = 25;
/** A due item the clock could not settle is asked again after this, not in a loop. */
const STUCK_RETRY_MS = 5_000;

/** The schedule board's side of the clock: when its next row is due and how to start the due ones. */
export type ClockBoard = {
  nextDueAt(): number | null;
  /** Starts at most `limit` due rows and returns how many it started. */
  fireDue(limit: number): Promise<number> | number;
};

export type ClockTimers = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };

export type ClockOptions = {
  board?: ClockBoard;
  /** The board-wide pause: while true nothing fires, only the beat goes on. */
  isPaused?: () => boolean;
  /** Stamped at every tick (the outage beat). */
  onBeat?: (at: number) => void;
  cap?: number;
  timers?: ClockTimers;
};

export type EngineClock = {
  /** Re-reads the nearest deadline and re-arms the single timer; called on every park, wake and board change. */
  arm(): void;
  stop(): void;
  /** One tick by hand (the timer's body). */
  tick(): Promise<number>;
  /** The armed target, or null when no timer is armed. */
  armedAt(): number | null;
};

const realTimers: ClockTimers = {
  set: (fn, ms) => { const handle = setTimeout(fn, ms); handle.unref?.(); return handle; },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The nearest absolute deadline over the waiting steps of live runs. */
export function nextStepDeadline(engine: WorkflowEngine): number | null {
  const row = engine.journal.db.prepare(`SELECT MIN(json_extract(s.await_json,'$.deadline')) AS at FROM lane_pilot_wf_step s
    JOIN lane_pilot_wf_run r ON r.id=s.run_id WHERE s.state='waiting' AND r.status IN ('waiting','running')
      AND json_type(s.await_json,'$.deadline') IN ('integer','real')`).get() as { at: number | null } | undefined;
  return typeof row?.at === "number" ? row.at : null;
}

/** Count of waiting steps across active workflow runs, for startup diagnostics. */
export function countWaitingSteps(engine: WorkflowEngine): number {
  const row = engine.journal.db.prepare(`SELECT COUNT(*) AS n FROM lane_pilot_wf_step s
    JOIN lane_pilot_wf_run r ON r.id=s.run_id WHERE s.state='waiting' AND r.status IN ('waiting','running')`).get() as { n: number } | undefined;
  return row?.n ?? 0;
}

/** One clock per engine: a single timer to MIN(deadline) over waiting steps and due board rows. */
export function startClock(engine: WorkflowEngine, options: ClockOptions = {}): EngineClock {
  const timers = options.timers ?? realTimers;
  const cap = options.cap ?? engine.options.overdueCap ?? DEFAULT_OVERDUE_CAP;
  let handle: unknown = null;
  let target: number | null = null;
  let source: "step" | "board" | "beat" = "beat";
  let stopped = false;
  let pausedLogged = false;
  let inFlight: Promise<number> | null = null;

  const paused = () => options.isPaused?.() ?? false;

  function arm(retryAfterMs?: number): void {
    if (handle !== null) timers.clear(handle);
    handle = null; target = null;
    if (stopped || engine.stopped()) return;
    const at = engine.now();
    let next = at + CLOCK_BEAT_MS;
    source = "beat";
    if (!paused()) {
      const step = nextStepDeadline(engine);
      const board = options.board?.nextDueAt() ?? null;
      if (step !== null && step < next) { next = step; source = "step"; }
      if (board !== null && board < next) { next = board; source = "board"; }
      if (next <= at && retryAfterMs !== undefined) next = at + retryAfterMs;
    }
    target = Math.max(next, at);
    engine.log(`clock armed next=${new Date(target).toISOString()} source=${source}`, "debug");
    handle = timers.set(() => { void tick(); }, target - at);
  }

  async function runTick(): Promise<number> {
    if (stopped || engine.stopped()) return 0;
    const at = engine.now();
    if (target !== null && source !== "beat" && at - target > CLOCK_DRIFT_WARN_MS) engine.log(`clock timer drift ${at - target}ms behind its target`, "warn");
    options.onBeat?.(at);
    let fired = 0;
    try {
      if (paused()) {
        if (!pausedLogged) { pausedLogged = true; engine.log("clock holds: the board is paused", "debug"); }
      } else {
        pausedLogged = false;
        fired += await settleDue(engine, { limit: cap, source: "clock" });
        if (options.board) fired += await options.board.fireDue(cap);
      }
    } catch (cause) {
      engine.log(`clock tick failed: ${cause instanceof Error ? cause.message : String(cause)}`, "error");
    }
    arm(fired > 0 ? 0 : STUCK_RETRY_MS);
    return fired;
  }

  function tick(): Promise<number> {
    if (inFlight) return inFlight;
    inFlight = runTick().finally(() => { inFlight = null; });
    return inFlight;
  }

  arm();
  return {
    arm: () => arm(),
    stop: () => { stopped = true; if (handle !== null) timers.clear(handle); handle = null; target = null; },
    tick,
    armedAt: () => target,
  };
}
