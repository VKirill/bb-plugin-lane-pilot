/**
 * Outage record (SMA atlas D2-10: «Outage declared», «The risen daemon speaks»). The plugin beats once a minute into its key-value store;
 * when it starts and the last beat is older than the threshold, the gap is an outage: the plugin was not running (the hub was down, the
 * plugin crashed or was not loaded). A reload by a deploy is a gap of seconds and stays under the threshold.
 */
export const BEAT_KEY = "outage:beat";
export const OUTAGE_THRESHOLD_MS = 5 * 60_000;
export type Outage = { fromAt: number; toAt: number; minutes: number };

export function gapOutage(lastBeat: number | null, now: number, thresholdMs = OUTAGE_THRESHOLD_MS): Outage | null {
  if (lastBeat === null || now - lastBeat <= thresholdMs) return null;
  return { fromAt: lastBeat, toAt: now, minutes: Math.round((now - lastBeat) / 60_000) };
}
