/**
 * The owner anamnesis tables of the plugin base (stream M1b): the same columns as the Mac-mini file store in store.ts,
 * under the `lane_pilot_owner_` prefix so they live next to the rest of Lane Pilot's data in `data.db`. Append-only:
 * these statements go at the end of `migrations` in src/rooms/storage/database.ts and their hashes into
 * tests/fixtures/migrations.lock.json; tests/sma-live.test.ts watches them through TABLE_CLOCKS and lp-wall-morning.sql.
 * The file store keeps its unprefixed names; a test in tests/anamnesis-hub-store.test.ts pins that the columns match.
 */
export const anamnesisOwnerMigrations: string[] = [
  `CREATE TABLE lane_pilot_owner_records(
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, statement TEXT NOT NULL DEFAULT '', attributes TEXT NOT NULL DEFAULT '{}',
    sensitivity TEXT NOT NULL, confidence REAL NOT NULL, status TEXT NOT NULL, first_seen INTEGER, last_seen INTEGER,
    manual_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, authored_by TEXT)`,
  `CREATE INDEX lane_pilot_owner_records_kind ON lane_pilot_owner_records(kind, status)`,
  `CREATE TABLE lane_pilot_owner_evidence(
    record_id TEXT NOT NULL REFERENCES lane_pilot_owner_records(id) ON DELETE CASCADE, source TEXT NOT NULL, ref TEXT NOT NULL, at INTEGER NOT NULL, quote TEXT,
    PRIMARY KEY(record_id, source, ref))`,
  `CREATE INDEX lane_pilot_owner_evidence_source ON lane_pilot_owner_evidence(source)`,
  `CREATE TABLE lane_pilot_owner_history(
    id INTEGER PRIMARY KEY AUTOINCREMENT, record_id TEXT NOT NULL, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL,
    changes TEXT NOT NULL DEFAULT '{}')`,
  `CREATE INDEX lane_pilot_owner_history_record ON lane_pilot_owner_history(record_id, id)`,
  `CREATE TABLE lane_pilot_owner_tombstones(id TEXT PRIMARY KEY, cutoff INTEGER NOT NULL)`,
  `CREATE TABLE lane_pilot_owner_checkpoints(source TEXT PRIMARY KEY, at INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL)`,
  `CREATE TABLE lane_pilot_owner_sources(source TEXT PRIMARY KEY, enabled INTEGER NOT NULL, changed_at INTEGER NOT NULL)`,
  `CREATE TABLE lane_pilot_owner_loads(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, mode TEXT NOT NULL, report TEXT NOT NULL)`,
  `CREATE TABLE lane_pilot_owner_notes_files(file TEXT PRIMARY KEY, hash TEXT NOT NULL, written_at INTEGER NOT NULL)`,
  `CREATE TABLE lane_pilot_owner_notes_lines(record_id TEXT PRIMARY KEY, file TEXT NOT NULL, line TEXT NOT NULL)`,
];
