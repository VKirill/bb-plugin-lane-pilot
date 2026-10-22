/**
 * The capability table (src/rooms/capability). One table, spread at the END of `migrations` in storage/database.ts.
 *
 * lane_pilot_capability: one receipt per provider, adapter version and capability: supported or not_supported, the model probed and why.
 * A new adapter version has no row until it is probed, which is what «unproven» means.
 */
export const capabilityMigrations: readonly string[] = [
  `CREATE TABLE lane_pilot_capability (
    provider_id TEXT NOT NULL,
    version TEXT NOT NULL,
    capability TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('supported','not_supported')),
    model TEXT,
    detail TEXT,
    at INTEGER NOT NULL,
    PRIMARY KEY (provider_id, version, capability)
  )`,
];
