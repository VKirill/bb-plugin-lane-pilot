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
