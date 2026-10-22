/**
 * The register of deferrals (SMA rule 5): a mandatory check, a skipped test, a gate or a plan decision that is put off
 * is written here, with a term the OWNER gave in his own message. Append only; the table is created by these statements, spread
 * at the end of `migrations` in storage/database.ts.
 *
 * state: `open` (a term in the future), `overdue` (the term passed: the drill is red), `closed` (closed_by holds the evidence),
 * `needs_owner_term` (it exists, nobody has a term from the owner yet: shown in the morning list, never counted overdue).
 */
export const deferralMigrations: readonly string[] = [
  `CREATE TABLE lane_pilot_deferral (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    what TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('drill_scenario','skipped_test','gate','plan_decision')),
    area TEXT NOT NULL DEFAULT '',
    due_at INTEGER,
    due_source TEXT,
    owner_ref TEXT,
    owner_quote TEXT,
    state TEXT NOT NULL CHECK(state IN ('open','overdue','closed','needs_owner_term')),
    history_json TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'cli',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER,
    closed_by TEXT
  )`,
  `CREATE INDEX lane_pilot_deferral_state ON lane_pilot_deferral(state, due_at)`,
];
