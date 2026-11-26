export type FailureClass = "transient" | "failure" | "product" | "exhausted";
export type BreakerOutcome = "ok" | FailureClass;
export type BreakerState = "closed" | "open" | "half_open";

export type ProviderBreakerOptions = {
  /** Failures inside the window that open the breaker. */
  failureThreshold?: number;
  /** How far back failures count. */
  windowMs?: number;
  /** How long the pair stays open before one trial call is allowed. */
  cooldownMs?: number;
  /** Restored entries (e.g. from durable hub storage across a restart). */
  initial?: Record<string, BreakerEntry>;
  /** Persistence callback invoked whenever breaker state changes. */
  onSave?: (entries: Record<string, BreakerEntry>) => void;
};

export type BreakerDecision =
  | { allow: true; state: "closed" }
  | { allow: true; state: "half_open"; trialToken: number }
  | { allow: false; state: "open"; retryAt: number; reason: string };

export type BreakerSnapshot = { key: string; state: BreakerState; failures: number; openedAt: number | null; lastOutcome: BreakerOutcome | null };

/** `holdUntil` is the provider's reset time when a limit named one: the pair stays open until then instead of the cooldown. */
export type BreakerEntry = { failures: number[]; openedAt: number | null; holdUntil: number | null; trialInFlight: boolean; trialToken: number | null; trialSerial: number; lastOutcome: BreakerOutcome | null };

const DEFAULTS = { failureThreshold: 3, windowMs: 10 * 60_000, cooldownMs: 5 * 60_000 };

export function breakerKey(providerId: string, model: string): string {
  return `${providerId}/${model}`;
}

// The provider refused for the plan, quota or credits: no retry inside the window will pass, so the pair opens at once.
// The ZCode app (provider zcode) cannot take the work now: another task holds it, its text is not visible, it needs the foreground, its sign-in expired, or promo is unavailable.
export const ZCODE_ENVIRONMENT_RE = /ZCode is busy|ZCode \((?:text-not-visible|foreground_required|session_expired|promo_unavailable)\)|sign in inside the ZCode app/i;
const EXHAUSTED = new RegExp(`writer_provider_limit:|${ZCODE_ENVIRONMENT_RE.source}`, "i");
const TRANSIENT = /rate.?limit|overload|429|503|stream.?(closed|disconnected)|ECONNRESET|socket hang up|timeout|provider_not_started|reconnect/i;
const HARD = /provider_error|system_error|thread_status_error|spawn_rejected|turn_rejected|provisioning_(failed|cancelled)|model.*not (found|available)|unauthori[sz]ed|401|403/i;

/**
 * A run can fail because the model did poor work (`product`) or because the provider did not work
 * (`transient`, `failure`). Only the latter two should move traffic to another provider.
 */
export function classifyFailure(detail: string | null | undefined): FailureClass {
  const text = (detail ?? "").trim();
  if (!text) return "product";
  if (EXHAUSTED.test(text)) return "exhausted";
  if (TRANSIENT.test(text)) return "transient";
  if (HARD.test(text)) return "failure";
  return "product";
}

export function createProviderBreaker(options: ProviderBreakerOptions = {}) {
  const config = { ...DEFAULTS, ...options };
  const entries = new Map<string, BreakerEntry>();

  function normalizeEntry(raw: Partial<BreakerEntry> | null | undefined, now: number): BreakerEntry | null {
    if (!raw || typeof raw !== "object") return null;
    const holdUntil = typeof raw.holdUntil === "number" && Number.isFinite(raw.holdUntil) ? raw.holdUntil : null;
    const openedAt = typeof raw.openedAt === "number" && Number.isFinite(raw.openedAt) ? raw.openedAt : null;
    if (openedAt === null && (!holdUntil || holdUntil <= now)) return null;
    return {
      failures: Array.isArray(raw.failures) ? raw.failures.filter((t): t is number => typeof t === "number" && Number.isFinite(t)) : [],
      openedAt,
      holdUntil,
      trialInFlight: false,
      trialToken: null,
      trialSerial: typeof raw.trialSerial === "number" ? raw.trialSerial : 0,
      lastOutcome: raw.lastOutcome ?? null,
    };
  }

  function restore(saved: Record<string, Partial<BreakerEntry>> | null | undefined, now = Date.now()): void {
    if (!saved || typeof saved !== "object") return;
    for (const [key, raw] of Object.entries(saved)) {
      const normalized = normalizeEntry(raw, now);
      if (normalized) entries.set(key, normalized);
    }
  }

  if (options.initial) restore(options.initial);

  function exportEntries(): Record<string, BreakerEntry> {
    const out: Record<string, BreakerEntry> = {};
    for (const [key, item] of entries) {
      if (item.openedAt !== null || item.failures.length > 0 || (item.holdUntil !== null && item.holdUntil > Date.now())) {
        out[key] = { ...item, failures: [...item.failures] };
      }
    }
    return out;
  }

  function persist(): void {
    config.onSave?.(exportEntries());
  }

  function entry(key: string): BreakerEntry {
    let found = entries.get(key);
    if (!found) {
      found = { failures: [], openedAt: null, holdUntil: null, trialInFlight: false, trialToken: null, trialSerial: 0, lastOutcome: null };
      entries.set(key, found);
    }
    return found;
  }

  function prune(item: BreakerEntry, now: number): void {
    item.failures = item.failures.filter((at) => now - at <= config.windowMs);
  }

  /** When an open pair may take a trial call: the reset time a limit named, else the cooldown after it opened. */
  function reopenAt(item: BreakerEntry): number {
    return item.holdUntil ?? (item.openedAt ?? 0) + config.cooldownMs;
  }

  function stateOf(item: BreakerEntry, now: number): BreakerState {
    if (item.openedAt === null) return "closed";
    return now >= reopenAt(item) ? "half_open" : "open";
  }

  /** The reset time still ahead that an open pair holds to: the one this limit named, or one an earlier limit named and is still ahead. */
  function holdFor(item: BreakerEntry, outcome: BreakerOutcome, now: number, until: number | undefined): number | null {
    const known = [outcome === "exhausted" ? until : undefined, item.holdUntil].filter((time): time is number => typeof time === "number" && time > now);
    return known.length ? Math.max(...known) : null;
  }

  function record(key: string, outcome: BreakerOutcome, now = Date.now(), until?: number): BreakerSnapshot {
    const item = entry(key);
    item.lastOutcome = outcome;
    if (outcome === "ok") {
      item.failures = [];
      item.openedAt = null;
      item.holdUntil = null;
      item.trialInFlight = false;
      item.trialToken = null;
    } else if (outcome !== "product") {
      item.failures.push(now);
      prune(item, now);
      const wasTrial = item.openedAt !== null && stateOf(item, now) === "half_open";
      if (wasTrial || outcome === "exhausted" || item.failures.length >= config.failureThreshold) {
        item.openedAt = now;
        item.holdUntil = holdFor(item, outcome, now, until);
        item.trialInFlight = false;
        item.trialToken = null;
      }
    }
    persist();
    return snapshotOf(key, item, now);
  }

  function decide(key: string, now = Date.now()): BreakerDecision {
    const item = entry(key);
    prune(item, now);
    const state = stateOf(item, now);
    if (state === "closed") return { allow: true, state };
    if (state === "half_open") {
      if (item.trialInFlight) return { allow: false, state: "open", retryAt: now + config.cooldownMs, reason: `${key}: trial call already in flight` };
      item.trialSerial += 1;
      item.trialToken = item.trialSerial;
      item.trialInFlight = true;
      return { allow: true, state, trialToken: item.trialSerial };
    }
    const retryAt = reopenAt(item);
    return { allow: false, state, retryAt, reason: `${key}: ${item.failures.length} provider failures in ${Math.round(config.windowMs / 60_000)} min; retry after ${new Date(retryAt).toISOString()}` };
  }

  /** Returns the open breaker's wake deadline when held at `now`, else null (read-only: claims no half-open trial). */
  function holdUntil(key: string, now = Date.now()): number | null {
    const item = entries.get(key);
    if (!item || stateOf(item, now) !== "open") return null;
    return reopenAt(item);
  }

  function snapshotOf(key: string, item: BreakerEntry, now: number): BreakerSnapshot {
    return { key, state: stateOf(item, now), failures: item.failures.length, openedAt: item.openedAt, lastOutcome: item.lastOutcome };
  }

  function snapshot(now = Date.now()): BreakerSnapshot[] {
    return [...entries.entries()].map(([key, item]) => snapshotOf(key, item, now));
  }

  /** Drops the half-open trial `token` from `decide`, and only that one. A closed allow took no trial; a newer trial has a newer token (2026-10-29 audit A-034). */
  function releaseTrial(key: string, token: number): void {
    const item = entries.get(key);
    if (!item || item.trialToken !== token) return;
    item.trialInFlight = false;
    item.trialToken = null;
    persist();
  }

  return { record, decide, holdUntil, releaseTrial, snapshot, restore, entries: exportEntries };
}

export type ProviderBreaker = ReturnType<typeof createProviderBreaker>;
