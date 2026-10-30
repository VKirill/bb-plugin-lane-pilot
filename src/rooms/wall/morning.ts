import { darkTableNames } from "../sma-map/live";
import type { WallDb } from "./journal";

/**
 * What the night loop did, in three lines for the morning summary (`bb lane-pilot wall morning`, the daily report). Nothing here waits for the
 * owner. scripts/lp-wall-morning.sql is the same three lines in SQL for the hub's daily script; tests/wall/morning.test.ts keeps the two equal.
 *   1. the classes and what the night spent,
 *   2. the repairs, as the night's verdict on each: adopt (accepted), hold (policy-held or unproven), reject (red, rolled back or being reverted),
 *   3. the guard: hunts, backlog, re-runs.
 */
export const WALL_MORNING_WINDOW_MS = 24 * 3_600_000;

const count = (db: WallDb, sql: string, ...params: unknown[]): number => (db.prepare(sql).get(...params) as { n: number }).n;
const millions = (tokens: number): string => (Math.round(tokens / 1e5) / 10).toFixed(1);

export function composeWallMorning(db: WallDb, now: number = Date.now(), windowMs: number = WALL_MORNING_WINDOW_MS): [string, string, string, string] {
  const since = now - windowMs;
  const open = count(db, "SELECT count(*) AS n FROM lane_pilot_wall_class WHERE state='open' AND recur7>0");
  const started = count(db, "SELECT count(*) AS n FROM lane_pilot_wall_repair WHERE created_at>=?", since);
  const night = db.prepare("SELECT spend_tokens, cap_tokens FROM lane_pilot_wall_night WHERE started_at>=? ORDER BY started_at DESC LIMIT 1").get(since) as { spend_tokens: number; cap_tokens: number } | undefined;
  const repair = (state: string) => count(db, "SELECT count(*) AS n FROM lane_pilot_wall_repair WHERE state=? AND updated_at>=?", state, since);
  const hunts = count(db, "SELECT count(*) AS n FROM lane_pilot_wall WHERE hunt_state<>'none' AND updated_at>=?", since);
  const backlog = count(db, "SELECT count(*) AS n FROM lane_pilot_wall WHERE state='backlog'");
  const dispatched = count(db, "SELECT count(*) AS n FROM lane_pilot_wall_rerun WHERE state='dispatched' AND created_at>=?", since);
  const listed = count(db, "SELECT count(*) AS n FROM lane_pilot_wall_rerun WHERE state='listed' AND created_at>=?", since);
  return [
    `Ночная петля: классов с повтором ${open}, взято в ремонт ${started}; потрачено ${millions(night?.spend_tokens ?? 0)} из ${millions(night?.cap_tokens ?? 0)} млн токенов.`,
    `Ремонты ночи: слито ${repair("merged")}, adopt ${repair("accepted")}, hold ${repair("held") + repair("unproven")}, reject ${repair("rolled_back") + repair("red") + repair("rollback_pending")}.`,
    `Охранник цикла: охот ${hunts}, в беклоге ${backlog}, перепрогонов ${dispatched} (в списке ${listed}).`,
    // W32 rank 9: a table that wrote nothing for 30 days is a silent instrument; the sentence names it so a dark
    // sensor is visible, not guessed. `TABLE_CLOCKS` and scripts/lp-wall-morning.sql name every migration table.
    (() => { const dark = darkTableNames(db, now - 30 * 86_400_000); return dark.length ? `Тёмные таблицы (0 строк за 30 дней): ${dark.join(", ")}.` : "Тёмные таблицы: каждая писала за 30 дней."; })(),
  ];
}
