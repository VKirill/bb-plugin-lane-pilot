/**
 * Threads that are not Lane Pilot's but work in a folder where a Lane Pilot run merges writers' work.
 * Each guest entry is the window's lease (SMA k_st_sessions): identity, provider, last heartbeat, and the named
 * claims of file scope the window announced (SMA k_st_claims).
 */

/** A guest older than this no longer counts as working in the folder. */
export const GUEST_TTL_MS = 6 * 3600_000;
/** A claim of scope a person window announced: advisory, stored with the lease so it dies with it. */
export type Claim = { name: string; globs: string[]; description: string; base: string | null; threadId: string; at: number };
export type Guest = { threadId: string; at: number; providerId?: string; label?: string; claims?: Claim[] };

/** The locked work gets this long; a kv call that never returns must not block every later note for the folder. */
export const GUEST_LOCK_MS = 10_000;

/** Entries kept per folder before trimming starts, and the most claims a folder may hold (a new claim past it is refused). */
export const GUESTS_KEPT = 10;
/**
 * Trim to GUESTS_KEPT: expired entries go first (oldest first), then live entries with no claim (oldest first). A live entry
 * that holds a claim is never dropped, so the list may stay longer than the cap.
 */
export function trimGuests(guests: Guest[], now = Date.now()): Guest[] {
  const list = [...guests];
  const oldest = (rows: Guest[]) => rows.reduce<Guest | undefined>((best, row) => (!best || row.at < best.at ? row : best), undefined);
  while (list.length > GUESTS_KEPT) {
    const victim = oldest(list.filter((row) => now - row.at >= GUEST_TTL_MS)) ?? oldest(list.filter((row) => !row.claims?.length));
    if (!victim) break;
    list.splice(list.indexOf(victim), 1);
  }
  return list;
}
