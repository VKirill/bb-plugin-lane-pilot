/**
 * Outages of Lane Pilot (src/rooms/outage). One table, spread at the END of `migrations` in storage/database.ts.
 *
 * lane_pilot_outage: one row per gap in the plugin's heartbeat longer than the threshold: when the last beat was, when the plugin was
 * running again, how many minutes, and what was known (`cause`: a deploy on record in that window, or unknown).
 */
export const outageMigrations: readonly string[] = [
  `CREATE TABLE lane_pilot_outage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_at INTEGER NOT NULL,
    to_at INTEGER NOT NULL,
    minutes INTEGER NOT NULL,
    cause TEXT,
    noticed_at INTEGER NOT NULL
  )`,
];
