import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { buildDailyReport, composeDailyReport, dailyDue, mountReports, runOwnerPush, runSqliteChild, splitSql, createTelegramSender, TelegramNotReadyError, TG_CHAT_NAME, TG_TOKEN_NAME, TG_TOPIC_NAME } from "../src/rooms/reports/server";
import { loadPushConfig, savePushConfig } from "../src/rooms/owner-waiting/push";

const digest = { send: true, reason: null, text: "Lane Pilot: ждут владельца, новых — 1.\n• x", keys: ["k1", "k2"] };

describe("owner push (was scripts/lp-owner-push.sh)", () => {
  const base = () => ({ digest: async () => digest, ack: vi.fn(), send: vi.fn(async () => undefined), dryRun: () => false, log: vi.fn() });

  it("sends the text and then acknowledges exactly its keys", async () => {
    const deps = base();
    expect(await runOwnerPush(deps)).toEqual({ status: "sent" });
    expect(deps.send).toHaveBeenCalledWith(digest.text);
    expect(deps.ack).toHaveBeenCalledWith(["k1", "k2"]);
  });

  it("does not acknowledge when the send fails, so the next tick offers the same keys", async () => {
    const deps = { ...base(), send: vi.fn(async () => { throw new Error("HTTP 502"); }) };
    expect(await runOwnerPush(deps)).toMatchObject({ status: "failed" });
    expect(deps.ack).not.toHaveBeenCalled();
  });

  it.each(["quiet_hours", "nothing_new", "disabled"])("sends nothing when the plugin says %s", async (reason) => {
    const deps = { ...base(), digest: async () => ({ send: false, reason, text: "", keys: [] }) };
    expect(await runOwnerPush(deps)).toEqual({ status: "idle", reason });
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.ack).not.toHaveBeenCalled();
  });

  it("dry run composes and logs the text but sends and acknowledges nothing", async () => {
    const deps = { ...base(), dryRun: () => true };
    expect(await runOwnerPush(deps)).toEqual({ status: "dry_run" });
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining(digest.text));
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.ack).not.toHaveBeenCalled();
  });
});

describe("Telegram sender (Env Catalog, no secrets in code)", () => {
  const records: Record<string, string> = { [TG_TOKEN_NAME]: "123:SECRET", [TG_CHAT_NAME]: "2590", [TG_TOPIC_NAME]: "956258" };
  const secrets = (data: Record<string, string>) => ({ record: async (name: string) => (name in data ? { value: data[name]! } : null) });

  it("posts to the bot's sendMessage in the topic of the chat", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await createTelegramSender({ secrets: secrets(records), fetchImpl: fetchImpl as never })("привет");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { body: URLSearchParams }];
    expect(url).toBe("https://api.telegram.org/bot123:SECRET/sendMessage");
    expect(Object.fromEntries(init.body)).toEqual({ chat_id: "2590", message_thread_id: "956258", text: "привет" });
  });

  it("names the missing catalog record and sends nothing", async () => {
    const fetchImpl = vi.fn();
    const { [TG_TOPIC_NAME]: _topic, ...withoutTopic } = records;
    const send = createTelegramSender({ secrets: secrets(withoutTopic), fetchImpl: fetchImpl as never });
    await expect(send("x")).rejects.toBeInstanceOf(TelegramNotReadyError);
    await expect(send("x")).rejects.toThrow(TG_TOPIC_NAME);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("an HTTP refusal throws without the token in the message", async () => {
    const fetchImpl = vi.fn(async () => new Response("Bad Request: chat not found", { status: 400 }));
    const error = await createTelegramSender({ secrets: secrets(records), fetchImpl: fetchImpl as never })("x").catch((cause: Error) => cause);
    expect((error as Error).message).toContain("HTTP 400");
    expect((error as Error).message).not.toContain("SECRET");
  });
});

describe("splitSql and the sqlite child (what `sqlite3 -readonly` did)", () => {
  it("splits at semicolons outside quotes and comments", () => {
    expect(splitSql("-- a; comment\nselect 'a;b'; select 1 -- tail; x\n;  ;select \"q;\"")).toEqual(["select 'a;b'", "select 1 \n", 'select "q;"'].map((s) => s.trim()));
  });

  it("runs statements in order over two attached files, prints rows with | and empty NULL, and skips a failing statement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-sql-"));
    const data = new Database(join(dir, "data.db")); data.exec("create table t(a text, b integer); insert into t values ('x', 1), (null, 2)"); data.close();
    const core = new Database(join(dir, "core.db")); core.exec("create table projects(id text); insert into projects values ('p1')"); core.close();
    const result = await runSqliteChild({ file: join(dir, "data.db"), core: join(dir, "core.db"), script: "create temp table p(n integer); insert into p values (7); select a, b from t order by b; select * from missing_table; select id||(select n from p) from core.projects;" });
    expect(result.lines).toEqual(["x|1", "|2", "p17"]);
    expect(result.errors).toHaveLength(1);
  });

  it("is read-only: a write to the plugin database or to the core database fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-sql-"));
    new Database(join(dir, "data.db")).exec("create table t(a)");
    new Database(join(dir, "core.db")).exec("create table c(a)");
    const result = await runSqliteChild({ file: join(dir, "data.db"), core: join(dir, "core.db"), script: "insert into t values (1); insert into core.c values (1)" });
    expect(result.errors).toHaveLength(2);
  });
});

function hubFiles() {
  const dir = mkdtempSync(join(tmpdir(), "lp-daily-"));
  const data = new Database(join(dir, "data.db"));
  data.exec(`create table lane_pilot_run(id text primary key, project_id text not null);
    create table lane_pilot_attempt(id text primary key, run_id text not null, task_id text not null, state text not null, reason text, failure_code text, created_at integer not null, updated_at integer, harness_version text, thread_id text);
    create table lane_pilot_token_cursor(thread_id text primary key, provider_id text not null default '', last_provider text not null default '', total_json text not null default '{}');
    create table lane_pilot_failure_triage(project_id text, attempt_id text, reason text, origin text, failed_at integer);
    create table lane_pilot_project_settings(project_id text, key text, value text);`);
  const core = new Database(join(dir, "core.db")); core.exec("create table projects(id text primary key, name text); insert into projects values ('proj_real', 'SelfyStudio'), ('proj_sbx', 'LP sandbox 1')"); core.close();
  return { dir, data, dataFile: join(dir, "data.db"), coreFile: join(dir, "core.db") };
}

describe("the daily report (was scripts/lp-metrics-daily.sh)", () => {
  it("runs the real SQL files on a hub-shaped database and keeps the text of the script", async () => {
    const hub = hubFiles();
    const now = Date.now();
    hub.data.exec("insert into lane_pilot_run values ('r1', 'proj_real'), ('r2', 'proj_sbx')");
    const insert = hub.data.prepare("insert into lane_pilot_attempt(id, run_id, task_id, state, reason, created_at, updated_at, harness_version) values (?, ?, ?, ?, ?, ?, ?, '0.1.559')");
    insert.run("a1", "r1", "t1", "accepted", null, now - 3_600_000, now - 3_000_000);
    insert.run("a2", "r1", "t2", "blocked", "internal_error: x | y", now - 3_600_000, now - 3_000_000);
    insert.run("a3", "r2", "drill-1", "accepted", null, now - 3_600_000, now - 3_000_000);
    const text = await buildDailyReport({ db: hub.data, dataFile: hub.dataFile, coreFile: hub.coreFile, run: runSqliteChild, now: () => now });
    expect(text.startsWith("📊 Lane Pilot за сутки. ")).toBe(true);
    expect(text).toContain("Окно стабильности: день 1 из 7");
    expect(text).toContain("Песочницы и учения отдельно: 1 попыток, принято 100.0%");
    expect(text).toContain("Старые версии (до 0.1.559), для сравнения: 0 попыток, принято 0%");
    expect(text).toContain("(bb lane-pilot metrics).");
    // No deferral register in this database: that line is left out, the report is not.
    expect(text).not.toContain("Отсрочки: просрочено");
  });

  it("appends the morning blocks in the script's order and leaves out an empty one", () => {
    const parts = { live: "L", livew: "W", win: "w", orig: "", orch: "0%", sys: "0", ver: "0.1.1", old: "o", sand: "s", usage: "u", dfr: "Отсрочки: просрочено 0, открыто 1", morning: "M", wall: "", cover: "C", outages: "O" };
    const text = composeDailyReport(parts);
    expect(text).toContain("Провалы: нет.");
    expect(text).toContain("(bb lane-pilot metrics). Отсрочки: просрочено 0, открыто 1.");
    expect(text.endsWith("\n\nM\nC\nO")).toBe(true);
    expect(composeDailyReport({ ...parts, dfr: "", morning: "" })).not.toContain("Отсрочки");
  });

  it("is due once a day, from nine o'clock in the owner's time zone", () => {
    const at = (iso: string) => Date.parse(iso);
    expect(dailyDue(at("2026-11-14T07:30:00Z"), "Europe/Madrid", null).due).toBe(false); // 08:30 in Madrid (CET)
    expect(dailyDue(at("2026-11-14T08:00:00Z"), "Europe/Madrid", null)).toEqual({ due: true, day: "2026-11-14" });
    expect(dailyDue(at("2026-11-14T15:00:00Z"), "Europe/Madrid", "2026-11-14").due).toBe(false);
    expect(dailyDue(at("2026-11-15T08:00:00Z"), "Europe/Madrid", "2026-11-14").due).toBe(true);
  });
});

describe("the schedules", () => {
  function mount(opts: { dryRun?: boolean; send?: () => Promise<void>; now?: number }) {
    const db = new Database(":memory:");
    db.exec("create table lane_pilot_owner_config(key text primary key, value text not null, updated_at integer not null)");
    const schedules = new Map<string, () => Promise<void>>();
    const log = vi.fn();
    const ctx = { db, log, isDisposed: () => false, secrets: {}, bb: { background: { schedule: (name: string, _cron: string, fn: () => Promise<void>) => { schedules.set(name, fn); } } } };
    const ack = vi.fn();
    const send = vi.fn(opts.send ?? (async () => undefined));
    const run = vi.fn(async () => ({ lines: [] as string[], errors: [] as string[] }));
    if (opts.dryRun) db.prepare("insert into lane_pilot_owner_config values ('dry_run','on',1)").run();
    return { db, schedules, log, ack, send, run, mount: () => mountReports(ctx as never, { digest: async () => digest, ack, coreFile: "/none", send, run }) };
  }

  it("registers the owner push every 30 minutes and the daily report hourly (a tick sends once a day)", () => {
    const t = mount({});
    t.mount();
    expect([...t.schedules.keys()].sort()).toEqual(["daily-report", "owner-push"]);
  });

  it("owner-push tick sends the digest and acknowledges; with dry_run it only logs", async () => {
    const live = mount({}); live.mount();
    await live.schedules.get("owner-push")!();
    expect(live.send).toHaveBeenCalledTimes(1);
    expect(live.ack).toHaveBeenCalledWith(["k1", "k2"]);
    const dry = mount({ dryRun: true }); dry.mount();
    await dry.schedules.get("owner-push")!();
    expect(dry.send).not.toHaveBeenCalled();
    expect(dry.ack).not.toHaveBeenCalled();
  });

  it("the daily tick sends once on its day (after 09:00 in the owner's zone), not before, and not again; a failed send is tried again", async () => {
    vi.useFakeTimers();
    try {
      const t = mount({}); t.db.exec("create table lane_pilot_project_settings(project_id text, key text, value text)");
      t.mount();
      const tick = t.schedules.get("daily-report")!;
      vi.setSystemTime(Date.parse("2026-11-14T07:00:00Z")); // 08:00 in Madrid
      await tick();
      expect(t.send).not.toHaveBeenCalled();
      vi.setSystemTime(Date.parse("2026-11-14T08:00:00Z"));
      await tick(); await tick();
      expect(t.send).toHaveBeenCalledTimes(1);
      expect((t.send.mock.calls as unknown as string[][])[0]![0]).toMatch(/^📊 Lane Pilot за сутки\./);
      vi.setSystemTime(Date.parse("2026-11-15T08:00:00Z"));
      await tick();
      expect(t.send).toHaveBeenCalledTimes(2);

      const failing = mount({ send: async () => { throw new Error("offline"); } }); failing.db.exec("create table lane_pilot_project_settings(project_id text, key text, value text)");
      failing.mount();
      await failing.schedules.get("daily-report")!(); await failing.schedules.get("daily-report")!();
      expect(failing.send).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it("a failed owner-push send is logged and not acknowledged", async () => {
    const t = mount({ send: async () => { throw new Error("offline"); } }); t.mount();
    await t.schedules.get("owner-push")!();
    expect(t.ack).not.toHaveBeenCalled();
    expect(t.log).toHaveBeenCalledWith(expect.stringContaining("offline"));
  });

  it("the push settings carry dry_run next to the old keys", () => {
    const db = new Database(":memory:");
    db.exec("create table lane_pilot_owner_config(key text primary key, value text not null, updated_at integer not null)");
    expect(loadPushConfig(db as never).dryRun).toBeUndefined();
    expect(savePushConfig(db as never, { dry_run: "on" }).dryRun).toBe(true);
    expect(() => savePushConfig(db as never, { dry_run: "maybe" })).toThrow("on or off");
  });
});
