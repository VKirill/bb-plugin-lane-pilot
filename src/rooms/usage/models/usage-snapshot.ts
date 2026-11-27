import { DEFAULT_USAGE_SKIP_PERCENT } from "../settings";

/**
 * The session guard's spend facts (SMA k_hs_spend): constants and pure cap interpretation.
 */
/** The subscription whose windows a lane session's spend is: the provider of the session itself. */
export const SNAPSHOT_PROVIDER = "claude-code";
/** Machines asked at one time. */
export const SNAPSHOT_CONCURRENCY = 4;
/** An unchanged reading is written again after this long, so the guard's age check (SNAPSHOT_MAX_AGE_MS) stays met on a live machine. */
export const SNAPSHOT_HEARTBEAT_MS = 60 * 60_000;

/** `usage.skip_percent` set by a person to a number above 0 is a cap; unset or 0 (off) is not. */
export function humanSkip(raw: unknown): { skipSetByHuman: boolean; skipPercent: number } {
  const set = raw !== undefined && raw !== null && raw !== "" && Number.isFinite(Number(raw));
  return { skipSetByHuman: set && Number(raw) > 0, skipPercent: set ? Number(raw) : DEFAULT_USAGE_SKIP_PERCENT };
}
