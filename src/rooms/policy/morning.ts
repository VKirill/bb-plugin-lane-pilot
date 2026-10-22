import type Database from "better-sqlite3";

/**
 * The morning list: three lines the owner reads and answers or ignores. Nothing here waits for him.
 *   1. what only he can decide and is waiting,
 *   2. what went red overnight,
 *   3. what the night accepted.
 * A check that was green when its task was accepted and is red on main now (src/rooms/baseline, `bb lane-pilot regress`) is named at the end of line 2,
 * with the commit that broke it. scripts/lp-morning.sql is the same list in SQL for the daily report script; tests/policy/morning.test.ts keeps the two equal.
 */
type Db = Pick<Database.Database, "prepare">;
export const MORNING_WINDOW_MS = 24 * 3_600_000;

const count = (db: Db, sql: string, ...params: unknown[]): number => (db.prepare(sql).get(...params) as { n: number }).n;

export function composeMorningList(db: Db, now: number = Date.now(), windowMs: number = MORNING_WINDOW_MS): [string, string, string] {
  const since = now - windowMs;
  const waitingRules = count(db, "SELECT count(*) AS n FROM lane_pilot_rule_proposal WHERE state='proposed'");
  const waitingItems = count(db, "SELECT count(*) AS n FROM lane_pilot_learning_item WHERE state='pending_owner'");
  const red = db.prepare("SELECT state, count(*) AS n FROM lane_pilot_attempt WHERE updated_at>=? AND (state LIKE '%failed%' OR state IN ('blocked','provider_error')) GROUP BY state ORDER BY state").all(since) as Array<{ state: string; n: number }>;
  const accepted = count(db, "SELECT count(*) AS n FROM lane_pilot_attempt WHERE state='accepted' AND updated_at>=?", since);
  const adopted = count(db, "SELECT count(*) AS n FROM lane_pilot_rule_event WHERE action='adopted' AND at>=?", since);
  const confirmed = count(db, "SELECT count(*) AS n FROM lane_pilot_rule_event WHERE action='confirmed' AND at>=?", since);
  const broken = db.prepare("SELECT task_id, culprit_commit FROM lane_pilot_regression WHERE state='open' AND kind='regression' ORDER BY id LIMIT 3").all() as Array<{ task_id: string; culprit_commit: string | null }>;
  const brokenTotal = count(db, "SELECT count(*) AS n FROM lane_pilot_regression WHERE state='open' AND kind='regression'");
  const regressed = brokenTotal ? ` Сломано после приёмки: ${brokenTotal} (${broken.map((row) => `${row.task_id} ← ${row.culprit_commit ? row.culprit_commit.slice(0, 8) : "?"}`).join(", ")}).` : "";
  return [
    `Только владелец: ждут решения правил — ${waitingRules}, пунктов обучения — ${waitingItems}.`,
    `Красное за ночь: ${red.length ? `${red.reduce((sum, row) => sum + row.n, 0)} попыток (${red.map((row) => `${row.state} ${row.n}`).join(", ")})` : "ничего"}.${regressed}`,
    `Принято: ${accepted} попыток, правил на пробу ${adopted}, подтверждено ${confirmed}.`,
  ];
}
