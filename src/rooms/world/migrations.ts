/**
 * Table of the world room (Pixel World). One row, `id = 'main'`: the whole simulated world as JSON without its static map
 * (`@lane-pilot/world-sim` generates that again), the wall-clock time of the last tick (what a restart catches up from)
 * and when it was saved. Appended to the plugin's migrations, append only.
 */
export const worldMigrations: string[] = [
  `CREATE TABLE lane_pilot_world (
    id TEXT PRIMARY KEY,
    schema INTEGER NOT NULL,
    state_json TEXT NOT NULL,
    tick_at INTEGER NOT NULL,
    saved_at INTEGER NOT NULL
  )`,
];
