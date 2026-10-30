/** stats.epoch (global setting): the day Lane Pilot's quality metrics count from. Records before it stay, they are not counted.
 * Default 2026-10-31 — the first day of the plugin in its current shape (owner 2026-10-30). */
export const STATS_EPOCH_DEFAULT = "2026-10-31T00:00:00Z";
export const STATS_EPOCH_SETTING = "stats.epoch";

/** Milliseconds the metrics count from. A bad or empty setting falls back to the default. */
export function statsEpochMs(raw: unknown): number {
  const at = Date.parse(String(raw ?? STATS_EPOCH_DEFAULT));
  return Number.isNaN(at) ? Date.parse(STATS_EPOCH_DEFAULT) : at;
}

/** The date line the wall and the daily summary show. */
export const statsEpochLine = (epochMs: number): string => `счёт с ${new Date(epochMs).toISOString().slice(0, 10)}`;
