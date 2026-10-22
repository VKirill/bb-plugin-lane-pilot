/**
 * Memory tiers (src/rooms/memory-tiers). Two tables, spread at the END of `migrations` in storage/database.ts.
 *
 * lane_pilot_memory_promotion: a note of the cold tier (expired for idleness, no date of its own) that a PM query needed again and that was
 * brought back to the active corpus — the measure of «demotion instead of forgetting».
 * lane_pilot_memory_miss: a PM memory query that found nothing, active or cold: a candidate question for the golden set of memory-eval.
 */
export const memoryTierMigrations: readonly string[] = [
  `CREATE TABLE lane_pilot_memory_promotion (
    project_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    query TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (project_id, memory_id, at)
  )`,
  `CREATE TABLE lane_pilot_memory_miss (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    query TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
  `CREATE INDEX lane_pilot_memory_miss_project ON lane_pilot_memory_miss(project_id, at)`,
];
