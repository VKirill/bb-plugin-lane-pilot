/** Tables skipped on purpose: `*_next`/`_nv`/`_v` are rename-squash intermediates, `lane_pilot_memory_fts*` are FTS5
 * plumbing behind lane_pilot_memory — neither is an instrument. */
export const TABLE_SKIP_RE = /lane_pilot_(memory_fts|.*_next|.*_nv|.*_v)$/;

/** Clocks the generic convention cannot pick: the domain's activity column is not the created/updated pair, so the
 * choice stays manual — each entry says why. `day` is `lane_pilot_token_daily`'s TEXT date, read through strftime. */
const CLOCK_OVERRIDES: Record<string, string> = {
  lane_pilot_errand_episode: "updated_at",
  lane_pilot_owner_records: "updated_at",
  lane_pilot_regression: "found_at",
  lane_pilot_token_daily: "day",
};

/** Event-time columns, tried when a table has neither created_at nor updated_at (logs and receipts). */
const EVENT_CLOCKS = ["at", "occurred_at", "recorded_at", "noticed_at", "sent_at", "claimed_at", "issued_at", "triaged_at", "found_at", "used_at", "changed_at", "written_at", "cutoff", "started_at", "ended_at", "last_used_at"] as const;

/** The column a table's recency is read on, derived from its real columns (`""`: no clock — counted in full, a
 * dimension/cursor store). Only CLOCK_OVERRIDES names a clock by hand. */
export const clockForColumns = (table: string, cols: ReadonlySet<string>): string =>
  CLOCK_OVERRIDES[table]
  ?? (cols.has("created_at") ? "created_at"
    : cols.has("updated_at") ? "updated_at"
    : EVENT_CLOCKS.find((clock) => cols.has(clock)) ?? "");

const clockExpr = (clock: string): string | null =>
  clock === "day" ? "CAST(strftime('%s', day) AS INTEGER) * 1000" : clock || null;

export type DarkTableRow = { table: string; clock: string | null; n: number; last: number | null };

export type DarkDb = { prepare(sql: string): { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown } };

/** The lane_pilot_* tables this database actually has, with their columns — read off the live schema, so a new
 * migration table is watched the day it lands and a dropped one is not. */
function schemaOf(db: DarkDb): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'lane_pilot_%' AND name NOT LIKE ?").all("lane_pilot_memory_fts%") as Array<{ name: string }>).map((row) => row.name).sort();
  for (const name of names) {
    if (TABLE_SKIP_RE.test(name)) continue;
    tables.set(name, new Set((db.prepare("SELECT name FROM pragma_table_info(?)").all(name) as Array<{ name: string }>).map((row) => row.name)));
  }
  return tables;
}

/** Every `lane_pilot_*` table in this database, with the column its recency is read on. */
export function tableClocks(db: DarkDb): Record<string, string> {
  const clocks: Record<string, string> = {};
  for (const [table, cols] of schemaOf(db)) clocks[table] = clockForColumns(table, cols);
  return clocks;
}

/** The SQL a table's recency is counted on: a column name, or the day-as-ms expression `lane_pilot_token_daily` uses.
 * Pass the table's columns to derive the clock; without them only CLOCK_OVERRIDES can answer. */
export const darkClockExpr = (table: string, cols?: ReadonlySet<string>): string | null => {
  const clock = cols ? clockForColumns(table, cols) : CLOCK_OVERRIDES[table];
  return clock === undefined ? null : clockExpr(clock);
};

/** Every named table with the rows it took in the window — all rows when it has no clock. Absent tables are skipped. */
export function darkTables(db: DarkDb, since: number): DarkTableRow[] {
  return [...schemaOf(db)].map(([table, cols]) => {
    const clock = darkClockExpr(table, cols);
    const row = (clock
      ? db.prepare(`SELECT COUNT(*) AS n, MAX(${clock}) AS last FROM ${table} WHERE ${clock} >= ?`).get(since)
      : db.prepare(`SELECT COUNT(*) AS n, NULL AS last FROM ${table}`).get()) as { n: number; last: number | null };
    return { table, clock, n: row.n, last: row.last };
  });
}

/** The names of the tables that wrote nothing in the window — the «0 rows in 30 days» paragraph of the night summary. */
export function darkTableNames(db: DarkDb, since: number): string[] {
  return darkTables(db, since).filter((row) => row.n === 0).map((row) => row.table);
}
