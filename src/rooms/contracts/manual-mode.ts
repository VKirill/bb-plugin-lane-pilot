/**
 * «Ручной режим» (owner, 2026-11-28): while it is on, nothing in Lane Pilot starts by itself — no schedule, no
 * start-up resume, no sweep, no retry, no reminder, no write into a project. Only a person's press does something.
 */
export const MANUAL_MODE_KEY = "lp.manual_mode";

export type ManualModeState = { on: boolean; since: number | null; reason: string | null };

/** No saved state means manual (`fallbackOn`): a plugin enabled for the first time starts with nothing running on its own. */
export function parseManualMode(raw: unknown, fallbackOn = true): ManualModeState {
  if (!raw || typeof raw !== "object") return { on: fallbackOn, since: null, reason: null };
  const row = raw as { on?: unknown; since?: unknown; reason?: unknown };
  return {
    on: row.on !== false,
    since: typeof row.since === "number" ? row.since : null,
    reason: typeof row.reason === "string" ? row.reason : null,
  };
}

/** The in-process copy every automatic path reads synchronously; `load` runs once at start before any of them. */
export interface ManualMode {
  on(): boolean;
  state(): ManualModeState;
  /** `fallbackOn` is the state when nothing was saved; the hub keeps the default, the test suite starts automatic. */
  load(fallbackOn?: boolean): Promise<ManualModeState>;
  set(on: boolean, reason?: string): Promise<ManualModeState>;
}

type Kv = { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown> };

export function createManualMode(kv: Kv, now: () => number = Date.now): ManualMode {
  // Before `load` nothing automatic is wired (server.ts awaits it right after createCore); a core built alone, as in a
  // unit test, behaves as before manual mode existed. An unreadable store stays manual.
  let current: ManualModeState = { on: false, since: null, reason: null };
  return {
    on: () => current.on,
    state: () => current,
    async load(fallbackOn = true) {
      try { current = parseManualMode(await kv.get(MANUAL_MODE_KEY), fallbackOn); }
      catch (cause) { current = { on: true, since: null, reason: "store unreadable" }; throw cause; }
      return current;
    },
    async set(on, reason) {
      const next = { on, since: now(), reason: reason?.trim().slice(0, 300) || null };
      await kv.set(MANUAL_MODE_KEY, next);
      current = next;
      return current;
    },
  };
}
