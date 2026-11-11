/**
 * The owner at the keyboard (SMA atlas D2-6: «Daytime owner left alone», «Busy account skipped»). A message the owner types in a BB
 * thread Lane Pilot did not start (no role, run, attempt or spawn id in that thread's plugin metadata) marks that thread's provider.
 * Lane Pilot's own threads mark nothing. While a provider was used by the owner in the last minutes, writers keep off it — the
 * subscription is one account across the machines — and the writer chain moves to the next provider, as for an open breaker.
 * (2026-10-29 claude-guard)
 */
export const PRESENCE_WINDOW_MS = 10 * 60_000;
/** Kept so older callers still compile. Lane Pilot no longer reads this file; the marks come from BB threads. */
export const PRESENCE_FILE = "~/.agents/state/owner-presence.json";
export type Presence = { providerId: string; at: number; hostId: string; host: string | null };

const LANE_METADATA_KEYS = ["role", "lanePilotRunId", "attemptId", "spawnId"] as const;

/** True when this plugin's metadata shows Lane Pilot started the thread. The owner's own chats have none of these. */
export function laneOwnedMetadata(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const row = metadata as Record<string, unknown>;
  return LANE_METADATA_KEYS.some((key) => typeof row[key] === "string" && row[key] !== "");
}

/** The newest mark per provider over the machines' files; malformed files and entries are skipped. */
export function readPresence(files: ReadonlyArray<{ hostId: string; text: string }>): Presence[] {
  const newest = new Map<string, Presence>();
  for (const file of files) {
    let parsed: unknown;
    try { parsed = JSON.parse(file.text || "{}"); } catch { continue; }
    if (!parsed || typeof parsed !== "object") continue;
    for (const [providerId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const at = (value as { at?: unknown })?.at, host = (value as { host?: unknown })?.host;
      if (typeof at !== "number") continue;
      if ((newest.get(providerId)?.at ?? -1) < at) newest.set(providerId, { providerId, at, hostId: file.hostId, host: typeof host === "string" ? host : null });
    }
  }
  return [...newest.values()];
}

/** Why a writer keeps off a provider now, or null: the owner used it within the window. */
export function presenceHold(providerId: string, presence: readonly Presence[], now: number, windowMs = PRESENCE_WINDOW_MS): string | null {
  const mark = presence.find((row) => row.providerId === providerId);
  if (!mark || now - mark.at > windowMs) return null;
  return `owner_present:${providerId} used by the owner ${Math.max(0, Math.round((now - mark.at) / 60_000))} min ago on ${mark.host ?? mark.hostId}`;
}

/** The terminal journal (SMA m_sp_tjournal): one row per owner's own thread per day — ids and day only, never text. */
export type JournalRow = { day: string; threadId: string; providerId: string; hostId: string };
export const JOURNAL_KEEP_DAYS = 90;
/** Besides the ninety days, at most this many rows are kept (the oldest go first). */
export const JOURNAL_MAX_ROWS = 2000;
const dayKey = (at: number) => new Date(at).toISOString().slice(0, 10);

/** The journal after one mark: same thread same day counts once; rows over ninety days old are dropped; at most 2000 rows. */
export function journalAppend(rows: readonly JournalRow[], mark: { threadId: string; providerId: string; hostId: string; at: number }, now: number): JournalRow[] {
  const day = dayKey(mark.at);
  const keep = dayKey(now - (JOURNAL_KEEP_DAYS - 1) * 86_400_000);
  const kept = rows.filter((row) => row.day >= keep);
  if (day < keep || kept.some((row) => row.threadId === mark.threadId && row.day === day)) return kept;
  return [...kept, { day, threadId: mark.threadId, providerId: mark.providerId, hostId: mark.hostId }].slice(-JOURNAL_MAX_ROWS);
}

/** The report's last number (SMA m_sp_tjournal_report): on how many of the window's days the owner worked in his own threads. */
export function outsideWorkSummary(rows: readonly JournalRow[], now: number, attempts: number, days = 7): { days: number; windowDays: number; attempts: number; share: number } {
  const since = dayKey(now - (days - 1) * 86_400_000);
  const outside = new Set(rows.filter((row) => row.day >= since).map((row) => row.day)).size;
  return { days: outside, windowDays: days, attempts, share: outside / days };
}
