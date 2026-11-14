// Region 5 · Daemon life, batch c — the observations behind the proofs of the map nodes n503–n528 (docs/sma-evidence.md). Each function runs the REAL code of this checkout
// (the owner's digest, the calibration, scripts/hub-watchdog.sh and scripts/lp-owner-push.sh against stand-in tools) and returns plain data. tests/sma/four-proofs-r05-c.test.ts
// asserts these values; the drill scene sma_r05_c.py reads the same values (through sma_r05_c_probe.ts, vite-node) and compares them with the node card's result.
// No model, no hub, no network. The watchdog's `run` loop is driven with a stand-in `sleep` that logs its argument and ends the loop after a set number of sleeps, so a
// scenario of many knocks takes milliseconds and is exact (no waiting in real time).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { ackDigest, planDigest } from "../../src/rooms/owner-waiting/push";
import { closeOwnerItem, collectOwnerWaiting, postOwnerItem, type OwnerItemSweep } from "../../src/rooms/owner-waiting";
import { CALL_REASONS, callReason } from "../../src/rooms/owner-waiting/items";
import { calibrate, calibrationLine, scoreForecast, type Forecast, type ForecastFact } from "../../src/rooms/forecast/logic";
import { openDatabase } from "../../src/rooms/plugin-db";
import { BEAT_KEY } from "../../src/rooms/outage/logic";
import { STOP_KEY, recordStartGap } from "../../src/rooms/outage/server/outage";
import { listOutages } from "../../src/rooms/outage/store";
import { SLEEP_STUB, SYSTEMCTL_STUB, functions, pushScript, run as watchdog, script, stub, tmp } from "../helpers/hub-watchdog";

const HOUR = 3_600_000;
// 2026-10-22 09:00 in Madrid (CEST), outside the quiet hours.
const NOW = Date.UTC(2026, 9, 22, 7, 0, 0);
const scratch = () => openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
const post = (db: ReturnType<typeof scratch>, key: string, kind: string, at: number, source = "night", what = `${key} thing`) =>
  postOwnerItem(db, { key, source, kind, what, why: `${key}: why it is the owner's, long enough to read`, wake: true }, at);

/** A curl stand-in whose answer to the n-th knock is the n-th word of $CURL_SEQ (200 answers, 7 refuses, anything else times out; the last word repeats). A sendMessage goes to $TG_LOG. */
const SEQ_CURL = `for a in "$@"; do
  case "$a" in *sendMessage*) echo "$@" >> "$TG_LOG"; exit "\${TG_RC:-0}" ;; esac
done
n=0; [ -f "$CURL_STATE" ] && n="$(cat "$CURL_STATE")"
echo $((n + 1)) > "$CURL_STATE"
set -- $CURL_SEQ; i=$((n + 1)); [ "$i" -gt "$#" ] && i=$#
eval "tok=\\\${$i}"
case "$tok" in 200) echo 200; exit 0 ;; 7) echo 000; exit 7 ;; *) echo 000; exit 28 ;; esac`;
/** A sleep stand-in that logs its argument and, at the $SLEEP_MAX-th sleep, ends the watchdog it was called from. */
const ENDING_SLEEP = `echo "$1" >> "$SLEEP_LOG"; n=$(wc -l < "$SLEEP_LOG"); [ "$n" -ge "$SLEEP_MAX" ] && kill -TERM $PPID; exit 0`;

export type Drive = { seq: string; sleeps: number; mainpid?: string; mainAfter?: string; state?: string; telegram?: boolean; env?: Record<string, string>; before?: (dir: string) => void };
/** Runs `hub-watchdog.sh run` against stand-in curl, systemctl and sleep until it has slept `sleeps` times; returns what it wrote and sent. */
export function drive(o: Drive) {
  const { dir, env } = tmp();
  stub(dir, "curl", SEQ_CURL);
  stub(dir, "sleep", ENDING_SLEEP);
  const sys = stub(dir, "systemctl", SYSTEMCTL_STUB);
  writeFileSync(join(dir, "mainpid"), `${o.mainpid ?? "4242"}\n`);
  writeFileSync(join(dir, "state"), `${o.state ?? "active"}\n`);
  writeFileSync(join(dir, "lp.db"), "not a database");
  if (o.telegram !== false) writeFileSync(join(dir, "tg.env"), "TG_TOKEN=t\nTG_CHAT=1\n");
  o.before?.(dir);
  const e = {
    ...process.env, ...env, ...(o.telegram === false ? {} : { LP_WATCH_TG_ENV: join(dir, "tg.env") }), LP_WATCH_USER: "1", LP_WATCH_SYSTEMCTL: sys, CURL_SEQ: o.seq, CURL_STATE: join(dir, "curl.n"), TG_LOG: join(dir, "tg.log"),
    LP_WATCH_LP_DB: join(dir, "lp.db"), SYS_LOG: join(dir, "sys.log"), SLEEP_LOG: join(dir, "sleep.log"), SLEEP_MAX: String(o.sleeps), MAINPID_FILE: join(dir, "mainpid"), STATE_FILE: join(dir, "state"),
    ...(o.mainAfter ? { MAINPID_AFTER: o.mainAfter } : {}), ...o.env,
  };
  const done = spawnSync("bash", [script, "run"], { env: e, encoding: "utf8", timeout: 40000 });
  const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "");
  const rows = read("outages.jsonl").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { at: number; event: string; detail: string });
  return {
    dir, status: done.status, rows, events: rows.map((row) => row.event), tg: read("tg.log").split("\n").filter(Boolean),
    sys: read("sys.log").split("\n").filter(Boolean), sleeps: read("sleep.log").split("\n").filter(Boolean), file: (name: string) => read(name),
  };
}

const forecast = (files: number, first: boolean, tokens: number, minutes: number): Forecast => ({ files, checks_pass_first_try: first, tokens, minutes }) as Forecast;
const fact = (files: number, firstTry: boolean, tokens: number | null, minutes: number | null): ForecastFact => ({ files, firstTry, tokens, minutes });

export const observeC = {
  /** n503: the four reasons a person is called, from the kind of the row; the digest names each row with its reason, the costliest first. */
  m_sum_kinds() {
    const db = scratch();
    post(db, "d1", "choice", NOW - 4 * HOUR, "night", "pick the colour");
    post(db, "t1", "deferral_term", NOW - 3 * HOUR, "night", "the term ends");
    post(db, "w1", "wall", NOW - 2 * HOUR, "night", "work cannot go on");
    post(db, "r1", "canary_red", NOW - HOUR, "night", "the canary is red");
    const digest = planDigest(db, NOW);
    const kinds = ["canary_red", "outage_started", "deferral_term", "deadline", "wall", "stalled_batch", "needs_human", "choice", "acceptance"];
    return { reasons: [...CALL_REASONS], classes: Object.fromEntries(kinds.map((kind) => [kind, callReason(kind)])), lines: digest.text.split("\n").slice(1, 5) };
  },

  /** n504: ten waiting rows are one message, not a volley: one header with the count, the rows named, one footer. */
  m_sum_digest() {
    const db = scratch();
    for (let i = 0; i < 10; i++) post(db, `a${i}`, "choice", NOW - (20 - i) * HOUR, "night", `question ${i}`);
    const digest = planDigest(db, NOW);
    const lines = digest.text.split("\n");
    return { send: digest.send, keys: digest.keys, shown: digest.shown, more: digest.more, header: lines[0], rows: lines.slice(1, -1), footer: lines.at(-1)!.slice(0, 36) };
  },

  /** n505: the call is asked every tick but goes out once: after the acknowledgement the following ticks say nothing; acknowledging again adds nothing. */
  m_sum_raise() {
    const db = scratch();
    post(db, "a", "choice", NOW - HOUR);
    const first = planDigest(db, NOW);
    const added = ackDigest(db, first.keys, NOW);
    const ticks = [1, 2, 3, 4, 5].map((n) => { const d = planDigest(db, NOW + n * 30 * 60_000); return d.send ? d.keys : d.reason; });
    return { first: { send: first.send, keys: first.keys }, added, ticks, again: ackDigest(db, first.keys, NOW) };
  },

  /** n506: the memory of calls is a row of the owner's push table: a later look (a second start) does not repeat the call; the only repeat is one «still waiting» after six hours, never a third. */
  m_sum_said() {
    const db = scratch();
    post(db, "a", "choice", NOW - HOUR);
    ackDigest(db, planDigest(db, NOW).keys, NOW);
    const rows = db.prepare("SELECT key, pushed_at AS at FROM lane_pilot_owner_push").all();
    const look = (ms: number) => { const d = planDigest(db, NOW + ms); return d.send ? { keys: d.keys, text: d.text.split("\n")[1] } : d.reason; };
    const soon = look(HOUR), almost = look(6 * HOUR - 60_000), repeat = look(6 * HOUR);
    ackDigest(db, planDigest(db, NOW + 6 * HOUR).keys, NOW + 6 * HOUR);
    return { rows, soon, almost, repeat, later: look(30 * HOUR) };
  },

  /** n507: closed work is silent: a row the system closes (a backlog card marked done, a piece of a cancelled batch) or the owner closes leaves the digest; a closed row cannot be closed again. */
  m_sum_ghost() {
    const db = scratch();
    for (const key of ["backlog:done", "backlog:open", "batch:cancelled", "night:owner"]) post(db, key, "backlog_ready", NOW - HOUR, key.startsWith("backlog") ? "backlog" : "night");
    const before = planDigest(db, NOW).keys;
    const gone: OwnerItemSweep = (_db, item) => (item.key === "backlog:done" ? "janitor:card is done" : item.key === "batch:cancelled" ? "janitor:batch cancelled" : null);
    const swept = collectOwnerWaiting(db, NOW, [gone]).items.map((item) => item.key);
    const closed = closeOwnerItem(db, "night:owner", "screen", NOW);
    const after = planDigest(db, NOW).keys;
    const by = db.prepare("SELECT key, closed_by AS by FROM lane_pilot_owner_item WHERE state='closed' ORDER BY key").all();
    return { before, swept, after, closed, closedAgain: closeOwnerItem(db, "night:owner", "screen", NOW), missing: closeOwnerItem(db, "nope", "screen", NOW), by };
  },

  /** n508: after a failed send of the owner's call the next try waits five minutes (the script's own clock, a stand-in curl and bb). */
  m_sum_repeat() {
    const { dir } = tmp();
    mkdirSync(join(dir, ".config/lp-metrics"), { recursive: true });
    mkdirSync(join(dir, ".lane-pilot"));
    writeFileSync(join(dir, ".config/lp-metrics/tg.env"), "TG_TOKEN=t\nTG_CHAT=1\nTG_TOPIC=2\n");
    stub(dir, "bb", `echo '{"result":{"send":true,"text":"hi","keys":["k1"]}}'`);
    stub(dir, "curl", `echo "curl $*" >> "$CURL_LOG"; [ -f "$CURL_OK" ] && exit 0 || exit 22`);
    const failedAt = join(dir, ".lane-pilot/owner-push.failed-at");
    const env = { ...process.env, HOME: dir, PATH: `${join(dir, "bin")}:${process.env.PATH}`, LP_PUSH_FAILED_AT: failedAt, CURL_LOG: join(dir, "curl.log"), CURL_OK: join(dir, "ok") };
    const sends = () => (existsSync(join(dir, "curl.log")) ? readFileSync(join(dir, "curl.log"), "utf8").match(/sendMessage/g)?.length ?? 0 : 0);
    const push = () => { const done = spawnSync("bash", [pushScript], { env, encoding: "utf8" }); return { status: done.status, said: done.stdout.trim().split("\n")[0], sends: sends() }; };
    const ago = (seconds: number) => writeFileSync(failedAt, String(Math.floor(Date.now() / 1000) - seconds));
    const failed = push();
    ago(250); const at250 = push();
    ago(350); writeFileSync(join(dir, "ok"), ""); const at350 = push();
    return { failed, at250, at350, markerGone: !existsSync(failedAt) };
  },

  /** n509: the estimate-versus-fact report: per area and overall, the files error, the first-try hit rate and the median fact/forecast ratio (no hours); a model's own history only. */
  m_sp_report() {
    const row = (area: string | null, f: Forecast, x: ForecastFact, model: string | null = null) => ({ area, score: scoreForecast(f, x), model });
    const rows = [
      row("api", forecast(2, true, 1000, 10), fact(3, true, 1500, 20), "m1"), row("api", forecast(4, true, 2000, 30), fact(2, false, 2000, 30), "m1"),
      row("api", forecast(1, false, 1000, 10), fact(1, false, 3000, 50), "m2"), row("api", forecast(2, true, 1000, 10), fact(2, true, 2500, 10), "m2"),
      row("ui", forecast(1, true, 1000, 10), fact(1, true, null, 20), "m2"),
    ];
    const all = calibrate(rows);
    return { overall: all.overall, byArea: all.byArea, ofM1: calibrate(rows, "m1"), none: calibrate(rows, "m9"), line: calibrationLine(all.byArea[0]) };
  },

  /** n510: the watchdog knocks every 15 seconds (LP_WATCH_KNOCK_SEC overrides) and decides from the door, the process record and the lift only: live work in Lane Pilot's database changes nothing and the database is never opened. */
  m_w_knock() {
    const open = drive({ seq: "200", sleeps: 4, before: (dir) => { writeFileSync(join(dir, "sqlite3.log"), ""); stub(dir, "sqlite3", `echo "$*" >> "${join(dir, "sqlite3.log")}"`); } });
    const quick = drive({ seq: "200", sleeps: 3, env: { LP_WATCH_KNOCK_SEC: "7" } });
    const down = drive({ seq: "28", sleeps: 2, env: { LP_WATCH_SUSPECT_AFTER: "2", LP_WATCH_MAX_LIFTS: "1" }, before: (dir) => { writeFileSync(join(dir, "sqlite3.log"), ""); stub(dir, "sqlite3", `echo "$*" >> "${join(dir, "sqlite3.log")}"`); } });
    return { sleeps: open.sleeps, quick: quick.sleeps, sqliteCalls: open.file("sqlite3.log").trim(), outageEvents: down.events.filter((e) => e === "outage").length, downSqlite: down.file("sqlite3.log").trim() };
  },

  /** n511: a door that answers resets the silence count: seven silent knocks, an answer, seven more are no outage; without the answer in between they would be. */
  m_w_up() {
    const cut = drive({ seq: "28 28 28 28 28 28 28 200 28 28 28 28 28 28 28 200", sleeps: 16 });
    const straight = drive({ seq: "28", sleeps: 8 });
    return { cut: cut.events.filter((e) => e !== "start"), cutKnocks: cut.sleeps.length, straight: straight.events.filter((e) => e !== "start"), straightKnocks: straight.sleeps.length };
  },

  /** n512: the process that was silent answers again: «false alarm»; another process: «risen» (the risen daemon speaks, and the watchdog does not call it a false alarm). */
  m_w_back() {
    const same = drive({ seq: "28 28 28 200", sleeps: 7, env: { LP_WATCH_SUSPECT_AFTER: "2", LP_WATCH_MAX_LIFTS: "1" } });
    const other = drive({ seq: "28 28 28 200", sleeps: 7, mainAfter: "5151", env: { LP_WATCH_SUSPECT_AFTER: "2", LP_WATCH_MAX_LIFTS: "1" } });
    const tail = (d: ReturnType<typeof drive>) => d.events.slice(d.events.indexOf("outage"));
    const say = (d: ReturnType<typeof drive>, word: string) => d.tg.filter((line) => line.includes(word)).length;
    return { same: { tail: tail(same), falseAlarmSaid: say(same, "тревога была ложной"), risenSaid: say(same, "поднялся") }, other: { tail: tail(other), falseAlarmSaid: say(other, "тревога была ложной"), risenSaid: say(other, "поднялся") } };
  },

  /** n513: no process record (MainPID empty or 0) is a stop: the silence is not counted, nothing is lifted; with a record the same silence is an outage. */
  m_w_stopped() {
    const quiet = (mainpid: string) => drive({ seq: "28", sleeps: 6, mainpid, env: { LP_WATCH_SUSPECT_AFTER: "2" } });
    const zero = quiet("0"), empty = quiet(""), recorded = quiet("4242");
    const mine = (d: ReturnType<typeof drive>) => ({ outage: d.events.includes("outage"), lifted: d.sys.some((l) => /restart|kill/.test(l)) });
    return { zero: mine(zero), empty: mine(empty), recorded: mine(recorded) };
  },

  /** n514: a process the manager says is activating (or reloading) is still loading: silence is not counted, nothing is lifted; the same silence from an active one is an outage. */
  m_w_starting() {
    const quiet = (state: string) => drive({ seq: "28", sleeps: 6, state, env: { LP_WATCH_SUSPECT_AFTER: "2" } });
    const mine = (d: ReturnType<typeof drive>) => ({ outage: d.events.includes("outage"), lifted: d.sys.some((l) => /restart|kill/.test(l)) });
    return { activating: mine(quiet("activating")), reloading: mine(quiet("reloading")), active: mine(quiet("active")) };
  },

  /** n515: eight silent knocks in a row declare (seven do not); refused ones declare at three once the door has answered 200 from this process, at four with the setting at four. */
  m_w_suspect() {
    const dry = { LP_WATCH_DRY: "1" };
    const declared = (seq: string, sleeps: number, env: Record<string, string> = {}) => drive({ seq, sleeps, env: { ...dry, ...env } }).events.includes("outage");
    return {
      defaults: functions('echo "$REFUSED_AFTER $SUSPECT_AFTER"', tmp().env).trim(),
      sevenTimeouts: declared("28 28 28 28 28 28 28 200", 8), eightTimeouts: declared("28", 8), sevenThenAnswer: declared("7 7 7 7 7 7 7 200", 8), eightRefused: declared("7", 8),
      threeRefusedAfterAnswer: declared("200 7", 4), beforeTheThird: declared("200 7", 3), threeRefusedNeverAnswered: declared("7", 4),
      fourSetting: declared("200 7", 4, { LP_WATCH_REFUSED_AFTER: "4" }), fourSettingFifth: declared("200 7", 5, { LP_WATCH_REFUSED_AFTER: "4" }),
    };
  },
};

/** An outage the lift cannot end: knocks time out, the restart fails with a reason, the watchdog lifts once per outage and gives up; it records the failure, says it once and sleeps 600 s. */
const failedLift = () => drive({ seq: "28", sleeps: 9, env: { LP_WATCH_SUSPECT_AFTER: "2", LP_WATCH_MAX_LIFTS: "1", RESTART_ERR: "Job failed. See journalctl", RESTART_RC: "1" } });
const texts = (lines: string[]) => lines.map((line) => line.slice(line.indexOf("text=") + 5));
const shown = (d: ReturnType<typeof drive>) => d.rows.map((row) => [row.event, row.detail]);

export const observeC2 = {
  /** n516: the fall time is the first silence (declared knocks times the knock interval back), not the moment of the decision. */
  m_w_declared() {
    const d = drive({ seq: "28", sleeps: 10, env: { LP_WATCH_SUSPECT_AFTER: "3", LP_WATCH_MAX_LIFTS: "1" } });
    const silence = d.rows.find((row) => row.event === "first_silence")!, outage = d.rows.find((row) => row.event === "outage")!;
    const gap = outage.at - silence.at;
    return { order: d.events.slice(0, 4), gapIsThreeKnocks: gap >= 45 && gap <= 46, silence: silence.detail, outage: outage.detail };
  },

  /** n517: the hung process is killed first (by the manager, by its record), then the lift starts: the kill is issued before the restart. */
  m_w_kill() {
    const d = drive({ seq: "28", sleeps: 5, env: { LP_WATCH_SUSPECT_AFTER: "2", LP_WATCH_MAX_LIFTS: "1" } });
    return { rows: d.rows.filter((row) => row.event === "lift").map((row) => row.detail), manager: d.sys.filter((line) => /kill|restart/.test(line)) };
  },

  /** n518: the lift is the one command the restart verb uses (lift_cmd), issued once after the kill. */
  m_w_lift() {
    const d = drive({ seq: "28", sleeps: 5, env: { LP_WATCH_SUSPECT_AFTER: "2", LP_WATCH_MAX_LIFTS: "1" } });
    return { command: functions("lift_cmd", { ...tmp().env, LP_WATCH_USER: "1" }).trim(), issued: d.sys.filter((line) => /restart/.test(line)) };
  },

  /** n519: the outcome is the door's: a lift whose door answers in the wait records nothing more; a lift whose door stays silent records «without an outcome» with the wait, never a success. */
  m_w_pending() {
    const env = { LP_WATCH_SUSPECT_AFTER: "2", LP_WATCH_MAX_LIFTS: "1" };
    const answered = drive({ seq: "28 28 28 200", sleeps: 6, env }), silent = drive({ seq: "28", sleeps: 9, env });
    const tail = (d: ReturnType<typeof drive>) => shown(d).filter(([event]) => event === "lift" || event === "lift_without_outcome" || event === "out_of_tries");
    return { answered: tail(answered), silent: tail(silent) };
  },

  /** n522: out of tries the watchdog says it to the person and sleeps 600 s instead of looping. */
  m_w_abandoned() {
    const d = failedLift();
    return { outOfTries: d.rows.filter((row) => row.event === "out_of_tries").map((row) => row.detail), said: texts(d.tg).filter((text) => text.includes("не поднялся")), longSleeps: d.sleeps.filter((x) => x === "600").length, marker: d.file("hub-watchdog.out-tries-said") === "" };
  },
  /** n523: the record of one outage: first silence, declaration, lifts and their outcome, with times that never run backwards and the first silence the knocks before the declaration. */
  m_out_marker() {
    const d = failedLift();
    const silence = d.rows.find((row) => row.event === "first_silence")!, outage = d.rows.find((row) => row.event === "outage")!;
    return { rows: shown(d).filter(([event]) => !event!.startsWith("message")), gap: outage.at - silence.at >= 30 && outage.at - silence.at <= 31, ordered: d.rows.every((row, i) => i === 0 || row.at >= d.rows[i - 1]!.at - 31) };
  },
  /** n524: the message «it fell»: how long it has been silent, the kind of silence and the process that hangs. */
  m_out_fall_msg() {
    return texts(failedLift().tg).slice(0, 1);
  },
  /** n525: the second message, once per outage, carries the reason from the lift's own output. */
  m_out_lift_failed() {
    const d = failedLift();
    return { said: texts(d.tg).filter((text) => text.includes("не поднялся")), fellSaid: texts(d.tg).filter((text) => text.includes("упал")).length, events: d.events.filter((event) => event === "out_of_tries").length };
  },

  /** n526: the risen watchdog speaks only after the door answers: while silent only «fell» is said, after the answer «risen» with the minutes; a door that never fell is never announced. */
  m_out_announce() {
    const env = { LP_WATCH_SUSPECT_AFTER: "2", LP_WATCH_MAX_LIFTS: "1" };
    const risen = drive({ seq: "28 28 28 200", sleeps: 7, mainAfter: "5151", env }), silent = drive({ seq: "28", sleeps: 9, env }), healthy = drive({ seq: "200", sleeps: 3, env });
    return { risen: texts(risen.tg), whileSilent: texts(silent.tg).filter((text) => text.startsWith("Хаб BB поднялся")), healthy: healthy.tg };
  },

  /** n527: the outage is closed with a receipt row carrying every time: the last beat, the start, the minutes, the cause and when it was noticed. */
  async m_out_receipt() {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const now = Date.UTC(2026, 9, 22, 9, 0, 0), MIN = 60_000;
    await bb.storage.kv.set(BEAT_KEY, now - 30 * MIN);
    await bb.storage.kv.set(STOP_KEY, { reason: "the plugin was reloaded (a deploy or a settings change)", at: now - 29 * MIN });
    await recordStartGap({ bb, db, log: () => undefined } as never, now);
    return { rows: listOutages(db, 0), expectFrom: now - 30 * MIN, expectTo: now };
  },

  /** n528: the Telegram message goes only when a bot and a chat are paired; otherwise nothing is sent and the log names the reason; a refused send names the curl code; a good send is recorded with its text. */
  m_out_notify() {
    const { dir, env } = tmp();
    stub(dir, "curl", SEQ_CURL);
    const base = { ...env, CURL_STATE: join(dir, "n"), TG_LOG: join(dir, "tg.log"), CURL_SEQ: "200" };
    const rows = () => (existsSync(join(dir, "outages.jsonl")) ? readFileSync(join(dir, "outages.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { event: string; detail: string }) : []);
    const sends = () => (existsSync(join(dir, "tg.log")) ? readFileSync(join(dir, "tg.log"), "utf8").split("\n").filter(Boolean).length : 0);
    const out: Array<{ case: string; event: string; detail: string; sends: number }> = [];
    const attempt = (name: string, extra: Record<string, string>) => {
      const before = rows().length;
      functions('say "hello" || true', { ...base, ...extra });
      const row = rows().slice(before)[0]!;
      out.push({ case: name, event: row.event, detail: row.detail, sends: sends() });
    };
    const tgEnv = join(dir, "tg.env");
    attempt("no file", {});
    writeFileSync(tgEnv, "TG_CHAT=1\n"); attempt("no token", { LP_WATCH_TG_ENV: tgEnv });
    writeFileSync(tgEnv, "TG_TOKEN=t\n"); attempt("no chat", { LP_WATCH_TG_ENV: tgEnv });
    writeFileSync(tgEnv, "TG_TOKEN=t\nTG_CHAT=1\n"); attempt("refused", { LP_WATCH_TG_ENV: tgEnv, TG_RC: "22" });
    attempt("sent", { LP_WATCH_TG_ENV: tgEnv });
    return { out, noEnvPath: join(dir, "no-telegram") };
  },
};

export { NOW, HOUR, SLEEP_STUB, SYSTEMCTL_STUB, watchdog };
