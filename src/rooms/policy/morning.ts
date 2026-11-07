import type Database from "better-sqlite3";
import { ownerWaitingCounts, type OwnerItemSweep } from "../owner-waiting";
import { failedAttemptStateCounts, janitorSums, janitorKeptSample } from "../storage";
import { countOpenRegressions, listOpenRegressionRows } from "../baseline";

/**
 * The morning list: four lines of a report the owner may read; nothing in it asks him for anything (since 2026-10-22 the loop runs
 * without him).
 *   1. rules: what went on trial and was confirmed in the window, what waits for room,
 *   2. what went red overnight,
 *   3. what was accepted,
 *   4. deferrals: overdue (the deploy drill is red until an agent closes or moves them) and open, and what the owner's own words left for him.
 * A check that was green when its task was accepted and is red on main now (src/rooms/baseline, `bb lane-pilot regress`) is named at the end of line 2,
 * with the commit that broke it. scripts/lp-morning.sql is the same list in SQL for the daily report script; tests/policy/morning.test.ts keeps the two equal.
 */
type Db = Pick<Database.Database, "prepare">;
export const MORNING_WINDOW_MS = 24 * 3_600_000;

const count = (db: Db, sql: string, ...params: unknown[]): number => (db.prepare(sql).get(...params) as { n: number }).n;

export function composeMorningList(db: Db, now: number = Date.now(), windowMs: number = MORNING_WINDOW_MS, sweeps: readonly OwnerItemSweep[] = []): [string, string, string, string] {
  const since = now - windowMs;
  const waitingRules = count(db, "SELECT count(*) AS n FROM lane_pilot_rule_proposal WHERE state='proposed'");
  const red = failedAttemptStateCounts(db as never, since);
  const accepted = count(db, "SELECT count(*) AS n FROM lane_pilot_attempt WHERE state='accepted' AND updated_at>=?", since);
  const adopted = count(db, "SELECT count(*) AS n FROM lane_pilot_rule_event WHERE action='adopted' AND at>=?", since);
  const confirmed = count(db, "SELECT count(*) AS n FROM lane_pilot_rule_event WHERE action='confirmed' AND at>=?", since);
  const waiting = ownerWaitingCounts(db, now, sweeps);
  const broken = listOpenRegressionRows(db, 3);
  const brokenTotal = countOpenRegressions(db);
  const regressed = brokenTotal ? ` Сломано после приёмки: ${brokenTotal} (${broken.map((row) => `${row.task_id} ← ${row.culprit_commit ? row.culprit_commit.slice(0, 8) : "?"}${row.culprit_task && row.culprit_task !== row.task_id ? ` (виновник ${row.culprit_task})` : ""}`).join(", ")}).` : "";
  const janitor = janitorSums(db as never, since);
  const kept = janitorKeptSample(db as never, since);
  const janitorLine = janitor.bytes || kept.length
    ? ` Уборка копий: освобождено ${Math.round((janitor.bytes ?? 0) / 1e6)} МБ${kept[0]?.total ? `, держатся ${kept[0].total} (${kept.map((row) => row.v).join(", ")}${kept[0].total > kept.length ? ", …" : ""})` : ""}.`
    : "";
  return [
    `Правила: на пробу ${adopted}, подтверждено ${confirmed}, ждут места ${waitingRules}.`,
    `Красное за ночь: ${red.length ? `${red.reduce((sum, row) => sum + row.n, 0)} попыток (${red.map((row) => `${row.state} ${row.n}`).join(", ")})` : "ничего"}.${regressed}`,
    `Принято: ${accepted} попыток.`,
    `Отсрочки: просрочено ${waiting.overdue}, открыто ${waiting.open}. От твоих сообщений — ${waiting.inbox}.${janitorLine}`,
  ];
}
