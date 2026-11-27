import { SCHEDULE_PAUSED_ALL_KEY, type BoardPauseState } from "../../models/schedule";

type Kv = { get(key: string): Promise<unknown>; set(key: string, value: never): Promise<unknown> };

const OFF: BoardPauseState = { paused: false, reason: null, at: null };

/**
 * Held in memory so the clock can ask synchronously; persisted in the plugin store so a restart keeps a paused board paused.
 * `onChange` fires once per real change (the clock re-arms on it).
 */
export function createBoardPause(kv: Kv, deps: { now?: () => number; log?: (message: string) => void; onChange?: (state: BoardPauseState) => void } = {}) {
  const now = deps.now ?? Date.now;
  let state: BoardPauseState = OFF;
  return {
    async load(): Promise<BoardPauseState> {
      const stored = await kv.get(SCHEDULE_PAUSED_ALL_KEY) as Partial<BoardPauseState> | null;
      state = stored && stored.paused === true ? { paused: true, reason: stored.reason ?? null, at: stored.at ?? null } : OFF;
      return state;
    },
    isPaused: () => state.paused,
    state: () => state,
    async set(paused: boolean, reason?: string): Promise<boolean> {
      const next: BoardPauseState = paused ? { paused: true, reason: reason?.trim() || null, at: now() } : OFF;
      const changed = next.paused !== state.paused || next.reason !== state.reason;
      state = next;
      await kv.set(SCHEDULE_PAUSED_ALL_KEY, next as never);
      if (changed) {
        deps.log?.(paused ? `board paused: ${next.reason ?? "no reason given"}` : "board resumed");
        deps.onChange?.(next);
      }
      return changed;
    },
  };
}
