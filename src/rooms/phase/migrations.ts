/**
 * The phase and its book (SMA map: Phase graph, «Phase book», «Chain of book parts», «Book after every decision»). Spread at the END of
 * `migrations` in storage/database.ts.
 *
 * lane_pilot_phase: one row per phase. A phase is the owner's goal taken through seven stages on rails (discussion, planning, design,
 * execution, verification, acceptance, lessons): the phase driver (server/driver.ts) moves it only when the stage's gates pass in code and
 * wakes the PM at each turn with the one thing the stage needs. `stage` is where it is, `state` whether the driver moves it (active) or not
 * (pause_requested, paused, stopped, closed). JSON columns hold the stage records (logic.ts PhaseRecord).
 *
 * lane_pilot_phase_part: the phase book as an append-only chain: every decision, gate, return and verdict is one part with the hash of the
 * part before it, so the book cannot be rewritten without the chain showing it. Parts are never updated or deleted.
 */
export const phaseMigrations: readonly string[] = [
  `CREATE TABLE lane_pilot_phase (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    pm_thread_id TEXT NOT NULL,
    run_id TEXT,
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    stage TEXT NOT NULL CHECK(stage IN ('discussion','planning','design','execution','verification','acceptance','lessons','closed')),
    state TEXT NOT NULL CHECK(state IN ('active','pause_requested','paused','stopped','closed')),
    record_json TEXT NOT NULL DEFAULT '{}',
    edition INTEGER NOT NULL DEFAULT 1,
    poked_key TEXT,
    poked_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER
  )`,
  `CREATE INDEX lane_pilot_phase_live ON lane_pilot_phase(state, updated_at)`,
  `CREATE INDEX lane_pilot_phase_pm ON lane_pilot_phase(pm_thread_id, created_at)`,
  `CREATE TABLE lane_pilot_phase_part (
    phase_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    at INTEGER NOT NULL,
    section TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL,
    PRIMARY KEY(phase_id, seq)
  )`,
  `CREATE TRIGGER lane_pilot_phase_part_no_update BEFORE UPDATE ON lane_pilot_phase_part BEGIN SELECT RAISE(ABORT, 'phase book parts are append-only'); END`,
  `CREATE TRIGGER lane_pilot_phase_part_no_delete BEFORE DELETE ON lane_pilot_phase_part BEGIN SELECT RAISE(ABORT, 'phase book parts are append-only'); END`,
];
