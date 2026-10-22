import type Database from "better-sqlite3";

/**
 * The morning list: three lines the owner reads and answers or ignores. Nothing here waits for him.
 *   1. what only he can decide and is waiting,
 *   2. what went red overnight,
 *   3. what the night accepted.
 * scripts/lp-morning.sql is the same list in SQL for the daily report script; tests/policy/morning.test.ts keeps the two equal.
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
  return [
    `Только владелец: ждут решения правил — ${waitingRules}, пунктов обучения — ${waitingItems}.`,
    `Красное за ночь: ${red.length ? `${red.reduce((sum, row) => sum + row.n, 0)} попыток (${red.map((row) => `${row.state} ${row.n}`).join(", ")})` : "ничего"}.`,
    `Принято: ${accepted} попыток, правил на пробу ${adopted}, подтверждено ${confirmed}.`,
  ];
}
