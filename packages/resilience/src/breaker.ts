export type FailureClass = "transient" | "failure" | "product";
export type BreakerOutcome = "ok" | FailureClass;
export type BreakerState = "closed" | "open" | "half_open";

export type ProviderBreakerOptions = {
  /** Failures inside the window that open the breaker. */
  failureThreshold?: number;
  /** How far back failures count. */
  windowMs?: number;
  /** How long the pair stays open before one trial call is allowed. */
  cooldownMs?: number;
};

export type BreakerDecision =
  | { allow: true; state: "closed" | "half_open" }
  | { allow: false; state: "open"; retryAt: number; reason: string };

export type BreakerSnapshot = { key: string; state: BreakerState; failures: number; openedAt: number | null; lastOutcome: BreakerOutcome | null };

type Entry = { failures: number[]; openedAt: number | null; trialInFlight: boolean; lastOutcome: BreakerOutcome | null };

const DEFAULTS: Required<ProviderBreakerOptions> = { failureThreshold: 3, windowMs: 10 * 60_000, cooldownMs: 5 * 60_000 };

export function breakerKey(providerId: string, model: string): string {
  return `${providerId}/${model}`;
}

const TRANSIENT = /rate.?limit|overload|429|503|stream.?(closed|disconnected)|ECONNRESET|socket hang up|timeout|provider_not_started|reconnect/i;
const HARD = /provider_error|system_error|thread_status_error|spawn_rejected|turn_rejected|provisioning_(failed|cancelled)|model.*not (found|available)|unauthori[sz]ed|401|403/i;

/**
 * A run can fail because the model did poor work (`product`) or because the provider did not work
 * (`transient`, `failure`). Only the latter two should move traffic to another provider.
 */
export function classifyFailure(detail: string | null | undefined): FailureClass {
  const text = (detail ?? "").trim();
  if (!text) return "product";
  if (TRANSIENT.test(text)) return "transient";
  if (HARD.test(text)) return "failure";
  return "product";
}

export function createProviderBreaker(options: ProviderBreakerOptions = {}) {
  const config = { ...DEFAULTS, ...options };
  const entries = new Map<string, Entry>();

  function entry(key: string): Entry {
    let found = entries.get(key);
    if (!found) {
      found = { failures: [], openedAt: null, trialInFlight: false, lastOutcome: null };
      entries.set(key, found);
    }
    return found;
  }

  function prune(item: Entry, now: number): void {
    item.failures = item.failures.filter((at) => now - at <= config.windowMs);
  }

  function stateOf(item: Entry, now: number): BreakerState {
    if (item.openedAt === null) return "closed";
    return now - item.openedAt >= config.cooldownMs ? "half_open" : "open";
  }

  function record(key: string, outcome: BreakerOutcome, now = Date.now()): BreakerSnapshot {
    const item = entry(key);
    item.lastOutcome = outcome;
    if (outcome === "ok") {
      item.failures = [];
      item.openedAt = null;
      item.trialInFlight = false;
    } else if (outcome !== "product") {
      item.failures.push(now);
      prune(item, now);
      const wasTrial = item.openedAt !== null && stateOf(item, now) === "half_open";
      if (wasTrial || item.failures.length >= config.failureThreshold) {
        item.openedAt = now;
        item.trialInFlight = false;
      }
    }
    return snapshotOf(key, item, now);
  }

  function decide(key: string, now = Date.now()): BreakerDecision {
    const item = entry(key);
    prune(item, now);
    const state = stateOf(item, now);
    if (state === "closed") return { allow: true, state };
    if (state === "half_open") {
      if (item.trialInFlight) return { allow: false, state: "open", retryAt: now + config.cooldownMs, reason: `${key}: trial call already in flight` };
      item.trialInFlight = true;
      return { allow: true, state };
    }
    const retryAt = (item.openedAt ?? now) + config.cooldownMs;
    return { allow: false, state, retryAt, reason: `${key}: ${item.failures.length} provider failures in ${Math.round(config.windowMs / 60_000)} min; retry after ${new Date(retryAt).toISOString()}` };
  }

  function snapshotOf(key: string, item: Entry, now: number): BreakerSnapshot {
    return { key, state: stateOf(item, now), failures: item.failures.length, openedAt: item.openedAt, lastOutcome: item.lastOutcome };
  }

  function snapshot(now = Date.now()): BreakerSnapshot[] {
    return [...entries.entries()].map(([key, item]) => snapshotOf(key, item, now));
  }

  return { record, decide, snapshot };
}

export type ProviderBreaker = ReturnType<typeof createProviderBreaker>;
