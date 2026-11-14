import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { pluginRootFromModule } from "@lane-pilot/kit";
import { STATS_EPOCH_SETTING, settingValue, statsEpochMs } from "../../storage";
import { liveStability, renderLiveStability, type LiveAttempt } from "../../bench/server";
import type { SqlRun } from "./sql-runner";

/**
 * The daily Lane Pilot stability report for the owner's Telegram topic, as a plugin schedule (it was ~/.config/lp-metrics/daily.sh from
 * scripts/lp-metrics-daily.sh, a hub script). The same queries run on the same SQL files (scripts/lp-metrics-views.sql, lp-morning.sql,
 * lp-wall-morning.sql, lp-graph-coverage.sql, read from the plugin's own directory), read-only on the plugin database with the BB core
 * database attached, and the same text comes out. What changed: the SQL runs through sql-runner (a child process), the headline is
 * computed in place instead of by scripts/print-live-stability.ts, and the text goes out through the Telegram sender.
 * Left out on purpose: the SINCE_VERSION environment override (the version floor is always the newest attempt's, never below 0.1.193).
 */
type Db = Pick<Database.Database, "prepare" | "transaction">;
const DAY_MS = 86_400_000;

export type DailyParts = {
  live: string; livew: string; win: string; orig: string; orch: string; sys: string; ver: string; old: string; sand: string; usage: string;
  /** The deferral line, or "" when the database has no register yet. */
  dfr: string;
  /** Extra blocks appended in this order; an empty one is left out. */
  morning: string; wall: string; cover: string; outages: string;
};

export function composeDailyReport(p: DailyParts): string {
  let text = `📊 Lane Pilot за сутки. ${p.live} За 7 дней: ${p.livew}. Окно стабильности: ${p.win}. Провалы: ${p.orig || "нет"}. Доля orchestrator: ${p.orch}. Системных причин: ${p.sys}. Цель: orchestrator <5%, системных 0, принято ≥60%, 7 дней подряд. Старые версии (до ${p.ver}), для сравнения: ${p.old}. Песочницы и учения отдельно: ${p.sand}. Токены писателей за 7 дней (измерено/попыток): ${p.usage}; где провайдер не отдаёт расход (acp-cursor), цена «не измерено», не 0 (bb lane-pilot metrics).${p.dfr ? ` ${p.dfr}.` : ""}`;
  if (p.morning) text += `\n\n${p.morning}`;
  if (p.wall) text += `\n${p.wall}`;
  if (p.cover) text += `\n${p.cover}`;
  if (p.outages) text += `\n${p.outages}`;
  return text;
}

const joined = (lines: string[]) => lines.join("\n").replace(/\n+$/, "");

export type DailyDeps = {
  /** The plugin database (own connection, used only for the stats epoch) and its file, which the child reads. */
  db: Db;
  dataFile: string;
  coreFile: string;
  run: SqlRun;
  /** The directory with scripts/*.sql; defaults to the plugin's own. */
  scriptsDir?: string;
  now?: () => number;
};

/** Builds the report text. A part that fails leaves out only itself, as in the script; the main queries failing throws. */
export async function buildDailyReport(deps: DailyDeps): Promise<string> {
  const now = (deps.now ?? Date.now)();
  const dir = deps.scriptsDir ?? join(pluginRootFromModule(import.meta.url), "scripts");
  const file = (name: string): string => readFileSync(join(dir, name), "utf8");
  const optional = (name: string): string => { try { return file(name); } catch { return ""; } };
  const views = file("lp-metrics-views.sql");
  const job = (script: string) => deps.run({ file: deps.dataFile, core: deps.coreFile, script });

  // The script's q(): parameters, the views, then the query; a failing statement fails the report (set -e there).
  const q = async (days: number, sql: string): Promise<string> => {
    const result = await job(`create temp table lp_params(days integer, since_version text); insert into lp_params values (${days}, ''); ${views}\n${sql};`);
    if (result.errors.length) throw new Error(`daily report query failed: ${result.errors[0]}`);
    return joined(result.lines);
  };
  const day = (sql: string) => q(1, sql);
  const week = (sql: string) => q(7, sql);
  const since = "(select ms from lp_cut)";
  const ver = await day("select v from lp_floor");
  const win = await week("select case when count(*)=0 then 'ещё нет реальных попыток на этой версии' else 'день '||min(7, cast((strftime('%s','now')-min(created_at)/1000)/86400 as integer)+1)||' из 7, с '||date(min(created_at)/1000,'unixepoch') end from lp_attempt where scope='real' and cur=1");

  // The headline is tasks of live projects (src/rooms/bench/live-rate.ts), not attempts.
  const epoch = statsEpochMs(settingValue(deps.db as never, "*", STATS_EPOCH_SETTING) ?? undefined);
  const liveFor = async (days: number): Promise<string> => {
    const from = Math.max(now - days * DAY_MS, epoch);
    const result = await job(`select json_object('taskId', a.task_id, 'projectId', r.project_id, 'projectName', p.name, 'state', a.state, 'reason', a.reason, 'failureCode', a.failure_code, 'harnessVersion', a.harness_version, 'updatedAt', a.updated_at) from lane_pilot_attempt a join lane_pilot_run r on r.id = a.run_id left join core.projects p on p.id = r.project_id where a.created_at > ${Math.floor(from)}`);
    if (result.errors.length) throw new Error(`live stability query failed: ${result.errors[0]}`);
    // One JSON cell per row: a reason may hold the runner's `|` separator.
    const rows = result.lines.map((line) => JSON.parse(line) as LiveAttempt);
    return renderLiveStability(liveStability(rows, { floorVersion: ver, epochMs: epoch }), epoch);
  };
  const live = await liveFor(1);
  const livew = await liveFor(7);

  const orig = await day(`select group_concat(origin||' '||n, ', ') from (select origin, count(*) n from lp_triage where scope='real' and cur=1 and failed_at>${since} group by origin order by n desc)`);
  const orch = await day(`select coalesce(round(100.0*sum(origin='orchestrator')/nullif(count(*),0),1),0)||'%' from lp_triage where scope='real' and cur=1 and failed_at>${since}`);
  const sys = await day(`select count(*) from lp_triage where scope='real' and cur=1 and failed_at>${since} and (reason like '%page_cap%' or reason like '%lost in a plugin reload%' or reason like '%illegal stage transition%' or reason like '%factory registration%' or reason like '%stale API handle%' or reason like '%not a git repository%' or reason like '%owns_paths rejected .agents/%' or reason like '%SIGKILL%')`);
  const old = await day(`select count(*)||' попыток, принято '||coalesce(round(100.0*sum(state='accepted')/nullif(count(*),0),1),0)||'%' from lp_attempt where scope='real' and cur=0 and created_at>${since}`);
  const sand = await day(`select count(*)||' попыток, принято '||coalesce(round(100.0*sum(state='accepted')/nullif(count(*),0),1),0)||'%' from lp_attempt where scope='sandbox' and created_at>${since}`);
  const usage = await week(`select coalesce(group_concat(provider||' '||m||'/'||n, ', '), 'нет попыток') from (select provider, sum(measured) m, count(*) n from lp_attempt_usage where scope='real' and cur=1 and created_at>${since} group by provider order by n desc)`);

  // The register of deferrals: a database without the table gives an empty line, not an error.
  const dfr = await day(`select 'Отсрочки: просрочено '||coalesce(sum(state in ('open','overdue') and due_at<${now} and owner_ref is not null and due_source in ('explicit','relative','weekday')),0)||', открыто '||coalesce(sum(state in ('open','overdue') and due_at>=${now} and owner_ref is not null and due_source in ('explicit','relative','weekday')),0)||coalesce((select ' (просрочено: '||group_concat(substr(what,1,60)||' ['||id||']', '; ')||')' from (select id, what from lane_pilot_deferral where state in ('open','overdue') and due_at<${now} and owner_ref is not null and due_source in ('explicit','relative','weekday') order by due_at limit 3)),'') from lane_pilot_deferral`).catch(() => "");

  // The four extra blocks never block the report: a missing file or a failing statement leaves out only itself.
  const lenient = async (script: string): Promise<string> => { try { return joined((await job(script)).lines); } catch { return ""; } };
  const nowS = Math.floor(now / 1000);
  const sinceDay = (nowS - 86_400) * 1000;
  const morningSql = optional("lp-morning.sql");
  const wallSql = optional("lp-wall-morning.sql");
  const coverSql = optional("lp-graph-coverage.sql");
  return composeDailyReport({
    live, livew, win, orig, orch, sys, ver, old, sand, usage, dfr,
    morning: morningSql ? await lenient(`create temp table lp_morning(since integer, now integer); insert into lp_morning values (${sinceDay}, ${nowS * 1000});\n${morningSql}`) : "",
    wall: wallSql ? await lenient(`create temp table lp_morning(since integer); insert into lp_morning values (${sinceDay});\n${wallSql}`) : "",
    cover: coverSql ? await lenient(`create temp table lp_cover(since integer); insert into lp_cover values (${sinceDay});\n${coverSql}`) : "",
    outages: await lenient(`select 'Простои Lane Pilot: '||count(*)||' ('||sum(minutes)||' мин, дольше всего '||max(minutes)||' мин).' from lane_pilot_outage where to_at >= ${sinceDay} having count(*) > 0`),
  });
}

/** The owner's local calendar day and hour in `timezone`. */
export function localDayHour(now: number, timezone: string): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return { day: `${part("year")}-${part("month")}-${part("day")}`, hour: Number(part("hour")) };
}

/** The report goes out once a day, at the first tick from `at` o'clock (default 09:00) in the owner's time zone: a hub that was down at nine sends it when it is back, the same day. */
export const DAILY_AT_HOUR = 9;
export function dailyDue(now: number, timezone: string, lastSentDay: string | null, atHour: number = DAILY_AT_HOUR): { due: boolean; day: string } {
  const local = localDayHour(now, timezone);
  return { due: local.hour >= atHour && lastSentDay !== local.day, day: local.day };
}
