/**
 * «Waiting for the owner» (SMA D0-3). Three small tables, appended at the end of `migrations` (storage/database.ts):
 *  - `lane_pilot_owner_item`: the inbox of things only the owner can decide that no other table already holds. The night loop writes its
 *    proposals, walls and backlog escalations here with `postOwnerItem` (the stable shape of items.ts); nothing else writes it.
 *  - `lane_pilot_owner_push`: which item keys went to Telegram, so one waiting is one message.
 *  - `lane_pilot_owner_config`: the push settings (quiet hours, time zone, on/off).
 */
export const ownerWaitingMigrations: readonly string[] = [
  `CREATE TABLE lane_pilot_owner_item (
    key TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    project_id TEXT,
    what TEXT NOT NULL,
    why TEXT NOT NULL,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    actions_json TEXT NOT NULL DEFAULT '[]',
    wake INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL CHECK(state IN ('open','closed')),
    created_at INTEGER NOT NULL,
    closed_at INTEGER,
    closed_by TEXT
  )`,
  `CREATE INDEX lane_pilot_owner_item_state ON lane_pilot_owner_item(state, created_at)`,
  `CREATE TABLE lane_pilot_owner_push (
    key TEXT PRIMARY KEY,
    pushed_at INTEGER NOT NULL
  )`,
  `CREATE TABLE lane_pilot_owner_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
];
