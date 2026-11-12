/**
 * SQLite migrations for the Living Project Passport (`src/rooms/passport/`).
 * Appended at the end of `src/rooms/migrations.ts` and locked in `tests/fixtures/migrations.lock.json`.
 */
export const passportMigrations = [
  `CREATE TABLE IF NOT EXISTS lane_pilot_passport (
    project_id TEXT NOT NULL,
    scope_key TEXT NOT NULL DEFAULT '',
    schema_version INTEGER NOT NULL DEFAULT 1,
    passport_json TEXT NOT NULL,
    passport_md TEXT NOT NULL,
    completeness_score INTEGER NOT NULL DEFAULT 0,
    confirmed_count INTEGER NOT NULL DEFAULT 0,
    hypothesis_count INTEGER NOT NULL DEFAULT 0,
    unknown_count INTEGER NOT NULL DEFAULT 0,
    taboo_count INTEGER NOT NULL DEFAULT 0,
    primary_locale TEXT NOT NULL DEFAULT '',
    markets_json TEXT NOT NULL DEFAULT '[]',
    version INTEGER NOT NULL DEFAULT 1,
    sha256 TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL DEFAULT 'system',
    PRIMARY KEY (project_id, scope_key)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS lane_pilot_passport_verbatim (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    scope_key TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL,
    thread_id TEXT,
    run_id TEXT,
    question_asked TEXT NOT NULL DEFAULT '',
    owner_verbatim TEXT NOT NULL,
    extracted_paths_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_lp_passport_verbatim_proj
    ON lane_pilot_passport_verbatim (project_id, scope_key, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS lane_pilot_passport_pending (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    scope_key TEXT NOT NULL DEFAULT '',
    field_path TEXT NOT NULL,
    old_claim_json TEXT NOT NULL,
    proposed_claim_json TEXT NOT NULL,
    verbatim_id TEXT,
    reason TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','rejected')),
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_lp_passport_pending_proj
    ON lane_pilot_passport_pending (project_id, scope_key, state, created_at DESC)`,
] as const;
