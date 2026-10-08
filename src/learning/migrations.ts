/**
 * Tables of the learning room (src/learning). Appended to the plugin's migrations, append only.
 *
 * - `lane_pilot_learning_obs`: one row per owner message the hook saw. It keeps the judgments (Jev, the second opinion), never the
 *   message: `excerpt` is the first 280 characters after personal data was masked, and `body`/`prev` hold the masked text only while a
 *   message waits for the extractor (cleared when it has been read, or after a day). A sensitive message keeps neither.
 * - `lane_pilot_learning_item`: what the extractor drew out of a message and where it went. Every row names its message in `evidence`.
 * - `lane_pilot_learning_signal`: observations from other sources than the owner's messages (T8), written in observation mode.
 */
export const learningMigrations: string[] = [
  `CREATE TABLE lane_pilot_learning_obs (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    judged_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    chars INTEGER NOT NULL,
    excerpt TEXT,
    state TEXT NOT NULL CHECK(state IN ('skipped','observed','candidate','extracted','ignored')),
    skip_reason TEXT,
    sensitive INTEGER NOT NULL DEFAULT 0,
    jev_status TEXT,
    receipt_id INTEGER,
    kind TEXT,
    kind_p REAL,
    learn_p REAL,
    durable REAL,
    scope TEXT,
    frustration REAL,
    deadline REAL,
    route TEXT,
    second_status TEXT,
    second_kind TEXT,
    second_learn_p REAL,
    second_durable REAL,
    second_route TEXT,
    second_ms INTEGER,
    second_tokens INTEGER,
    final_route TEXT,
    body TEXT,
    prev TEXT,
    review TEXT,
    reviewed_at INTEGER
  )`,
  `CREATE INDEX lane_pilot_learning_obs_state ON lane_pilot_learning_obs(state, at)`,
  `CREATE INDEX lane_pilot_learning_obs_project ON lane_pilot_learning_obs(project_id, at)`,
  `CREATE INDEX lane_pilot_learning_obs_judged ON lane_pilot_learning_obs(judged_at)`,
  `CREATE TABLE lane_pilot_learning_item (
    id TEXT PRIMARY KEY,
    obs_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('rule','preference','decision','deadline','fact')),
    text TEXT NOT NULL,
    audience TEXT,
    reach TEXT NOT NULL,
    due_at INTEGER,
    state TEXT NOT NULL CHECK(state IN ('adopted','proposed','pending_owner','accepted','duplicate','rejected','dropped','noted')),
    target TEXT,
    evidence TEXT NOT NULL,
    duplicate_of TEXT,
    confirmations INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    announced_at INTEGER
  )`,
  `CREATE INDEX lane_pilot_learning_item_project ON lane_pilot_learning_item(project_id, created_at)`,
  `CREATE INDEX lane_pilot_learning_item_state ON lane_pilot_learning_item(state, announced_at)`,
  `CREATE TABLE lane_pilot_learning_signal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    project_id TEXT,
    ref TEXT NOT NULL,
    p REAL,
    detail TEXT,
    state TEXT NOT NULL DEFAULT 'observed',
    at INTEGER NOT NULL,
    UNIQUE(kind, ref)
  )`,
];
