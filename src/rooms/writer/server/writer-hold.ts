import { breakerKey } from "@lane-pilot/resilience";
import { PRESENCE_WINDOW_MS } from "../../owner-presence";
import { usageHoldReason, usageSkipPercent } from "../../usage/server";
import type { UsageHold } from "../../usage/server/provider-usage";
import type { createProviderBreaker } from "@lane-pilot/resilience";
import type { Presence } from "../../owner-presence";

/**
 * H2: the availability check that ran inside the spawn (after an attempt was created) answers before an attempt is
 * spent. Same sources as the spawn gate: the provider breaker, owner presence, the core allowlist and the usage
 * window. A hold names `until` — the time the check can pass again (presence mark + the 10-minute window, the
 * window's resetsAt, the breaker's next half-open, else a short recheck); `core_unsupported` has none, no wait fixes it.
 */
export type WriterHold = { reason: string; until: number | null };

export type WriterHoldDeps = {
  breaker: ReturnType<typeof createProviderBreaker>;
  presence: { holds(providerId: string, now?: number): string | null; current(): Presence[] } | undefined;
  usage: { hold(input: { providerId: string; model: string; hostId: string; threshold: number; settings?: Record<string, unknown> }): Promise<UsageHold | null> };
  /** The core's allowlist (coreHostsRequiredProvider): false when this core cannot run the provider at all. */
  coreHosts: (providerId: string) => boolean;
};

export type WriterCandidate = { providerId: string; model: string; reasoningLevel?: string };

/** Holds a usage window without a named reset only this long before the chain is asked again. */
const USAGE_UNKNOWN_RESET_MS = 15 * 60_000;
/** A breaker opened but no reset was named: half-open is tried after the cool-down (breaker.ts default 5 min). */
const BREAKER_RECHECK_MS = 5 * 60_000;

/**
 * Why this provider/model may not take a writer now, or null. Never throws: a source that cannot answer holds
 * nothing, as the spawn gate reads it.
 */
export async function writerHold(
  input: { providerId: string; model: string; hostId: string; settings: Record<string, unknown> },
  deps: WriterHoldDeps,
  now = Date.now(),
): Promise<WriterHold | null> {
  try {
  if (!input.providerId) return null;
  // The breaker is asked through its read-only snapshot: `decide` would spend the half-open trial another caller's
  // spawn may need. An open pair frees at its reopen time; a snapshot gives openedAt, so +5 min is the recheck.
  const open = deps.breaker.snapshot(now).find((row) => row.key === breakerKey(input.providerId, input.model) && row.state === "open");
  if (open) {
    const until = open.openedAt !== null ? open.openedAt + BREAKER_RECHECK_MS : now + BREAKER_RECHECK_MS;
    return { reason: `writer_provider_unavailable:breaker_open:${open.key}: ${open.failures} provider failures`, until: Math.max(until, now + 1) };
  }
  const mark = deps.presence?.current().find((row) => row.providerId === input.providerId) ?? null;
  if (mark && now - mark.at <= PRESENCE_WINDOW_MS) {
    const reason = deps.presence!.holds(input.providerId, now) ?? `owner_present:${input.providerId}`;
    return { reason: `writer_provider_unavailable:${reason}`, until: mark.at + PRESENCE_WINDOW_MS };
  }
  if (!deps.coreHosts(input.providerId)) {
    return { reason: `writer_provider_unavailable:core_unsupported:${input.providerId}`, until: null };
  }
  const spent = await deps.usage.hold({ providerId: input.providerId, model: input.model, hostId: input.hostId,
    threshold: usageSkipPercent(input.settings), settings: input.settings }).catch(() => null);
  if (spent) {
    const reset = spent.resetsAt ? Date.parse(spent.resetsAt) : NaN;
    return { reason: usageHoldReason(input.providerId, input.model, spent), until: Number.isFinite(reset) ? reset : now + USAGE_UNKNOWN_RESET_MS };
  }
  return null;
  } catch {
    // A source that cannot answer holds nothing, as the spawn gate reads it.
    return null;
  }
}

export type ChainWalk<T extends WriterCandidate = WriterCandidate> = {
  /** The first member that may take the task now, with its place in the chain; undefined when all are held. */
  free: { member: T; index: number } | undefined;
  /** Every member was refused for a reason no wait fixes (core_unsupported). */
  allUnsupported: boolean;
  /** The shortest hold (the one whose `until` ends first), for the attempt's `waiting_writer:<reason>` and the board line. */
  shortest: { member: T; hold: WriterHold } | undefined;
  /** The earliest time a member frees; null only when allUnsupported. */
  wakeAt: number | null;
  /** The per-member holds, for receipts and the «which provider to change» item. */
  holds: Array<{ member: T; hold: WriterHold }>;
};

/**
 * Walks the writer chain (the writer's own pair first, then the fallbacks and the PM) and says who takes the task or
 * when to ask again. Every member is checked — the all-unsupported decision needs the whole picture.
 */
export async function walkWriterChain<T extends WriterCandidate>(
  members: readonly T[],
  input: { hostId: string; settings: Record<string, unknown> },
  deps: WriterHoldDeps,
  now = Date.now(),
): Promise<ChainWalk<T>> {
  const holds: Array<{ member: T; hold: WriterHold }> = [];
  let free: { member: T; index: number } | undefined;
  for (const [index, member] of members.entries()) {
    const hold = await writerHold({ providerId: member.providerId, model: member.model, hostId: input.hostId, settings: input.settings }, deps, now);
    if (hold) holds.push({ member, hold });
    else if (!free) free = { member, index };
  }
  const timed = holds.flatMap((row) => (row.hold.until !== null ? [row.hold.until] : []));
  const shortest = holds.slice().sort((a, b) => {
    if (a.hold.until === null) return 1;
    if (b.hold.until === null) return -1;
    return a.hold.until - b.hold.until;
  })[0];
  return { free,
    allUnsupported: !free && holds.length > 0 && holds.every((row) => row.hold.until === null),
    shortest, wakeAt: timed.length ? Math.min(...timed) : null, holds };
}

/** The attempt's machine-readable reason while it waits; the metrics count this prefix. */
export const WAITING_WRITER_PREFIX = "waiting_writer:";

export const waitingWriterReason = (hold: WriterHold): string => `${WAITING_WRITER_PREFIX}${hold.reason}`;

/** The provider's display name in owner-facing text; an id nobody knows stays itself. */
const PROVIDER_NAMES: Record<string, string> = {
  "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", opencode2: "OpenCode v2",
  "acp-cursor": "Cursor", devin: "Devin", zcode: "ZCode", router9: "9Router",
};
export const providerDisplayName = (providerId: string): string => PROVIDER_NAMES[providerId] ?? providerId;

/**
 * The board/PM line for a hold, in plain Russian: «владелец работает в Claude Code», «лимит claude-code/sonnet
 * почти исчерпан», «провайдер codex временно недоступен после сбоев».
 */
export function waitingWriterText(hold: WriterHold, wakeAt: number | null, now = Date.now()): string {
  const reason = hold.reason;
  const what = reason.includes("owner_present")
    ? `владелец работает в ${providerDisplayName(/owner_present:([^\s:]+)/.exec(reason)?.[1] ?? "?")}`
    : reason.includes("usage_window")
      ? `лимит ${providerDisplayName(/usage_window:([^/\s:]+)/.exec(reason)?.[1] ?? "?")} почти исчерпан`
      : reason.includes("breaker_open")
        ? `провайдер ${providerDisplayName(/breaker_open:([^/\s:]+)/.exec(reason)?.[1] ?? "?")} временно недоступен после сбоев`
        : reason.includes("core_unsupported")
          ? `${providerDisplayName(/core_unsupported:([^\s:]+)/.exec(reason)?.[1] ?? "?")} не поддерживается этим ядром`
          : "все писатели заняты";
  const eta = wakeAt === null ? "" : `, проверка через ${Math.max(1, Math.ceil((wakeAt - now) / 60_000))} мин`;
  return `Ждёт писателя: ${what}${eta}`;
}
