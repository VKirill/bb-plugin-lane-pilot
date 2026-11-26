import { ERRAND_EPISODE_TABLE } from "../../../contracts/server";

type Db = { prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown } };

/** The episode table's columns, or an empty set when the table itself is not there (a pre-episode database). */
export function episodeColumns(db: Db): Set<string> {
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(ERRAND_EPISODE_TABLE) as { name: string } | undefined;
    if (!table) return new Set();
    return new Set((db.prepare(`PRAGMA table_info(${ERRAND_EPISODE_TABLE})`).all() as Array<{ name: string }>).map((row) => row.name));
  } catch { return new Set(); }
}
