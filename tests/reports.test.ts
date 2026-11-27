import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { WorkflowEngine, parseWorkflow } from "@lane-pilot/workflow-engine";
import { createAttempt, createRun, openDatabase } from "../src/rooms/plugin-db";
import { transitionAttempt } from "../src/rooms/storage";
import { loadPushConfig, savePushConfig } from "../src/rooms/owner-waiting/server";
import { postOwnerItem } from "../src/rooms/owner-waiting";
import { insertDeferral } from "../src/rooms/deferral/server/repositories/deferral-repository";
import { insertOutage } from "../src/rooms/outage/server";
import { recordRouteMiss } from "../src/rooms/workflow/server";
import {
  buildDailyReport,
  composeDailyReport,
  createTelegramSender,
  DAILY_DRY_KEY,
  DAILY_SENT_KEY,
  dailyDue,
  mountReports,
  runOwnerPush,
  TelegramNotReadyError,
  TelegramSendError,
  TG_CHAT_NAME,
  TG_TOKEN_NAME,
  TG_TOPIC_NAME,
} from "../src/rooms/reports/server";

const digest = { send: true, reason: null, text: "Lane Pilot: ждут владельца, новых — 1.\n• x", keys: ["k1", "k2"] };

const ownerPushWorkflow = parseWorkflow(
  JSON.parse(readFileSync(new URL("../workflows/lp.owner-push.json", import.meta.url), "utf8")),
);
const dailyReportWorkflow = parseWorkflow(
  JSON.parse(readFileSync(new URL("../workflows/lp.daily-report.json", import.meta.url), "utf8")),
);

describe("owner push", () => {
  it("sends the text and then acknowledges exactly its keys", async () => {
    const sent: string[] = [];
    const ack = vi.fn();
    const res = await runOwnerPush({
      digest: async () => digest,
      ack,
      send: async (text) => { sent.push(text); },
      dryRun: () => false,
      log: () => undefined,
    });
    expect(res).toEqual({ status: "sent" });
    expect(sent).toEqual([digest.text]);
    expect(ack).toHaveBeenCalledWith(["k1", "k2"]);
  });

  it("does not acknowledge when the send fails, so the next tick offers the same keys", async () => {
    const ack = vi.fn();
    const log = vi.fn();
    const res = await runOwnerPush({
      digest: async () => digest,
      ack,
      send: async () => { throw new Error("network down"); },
      dryRun: () => false,
      log,
    });
    expect(res).toEqual({ status: "failed", reason: "network down" });
    expect(ack).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("network down"));
  });

  it("dry run composes and logs the text but sends and acknowledges nothing", async () => {
    const send = vi.fn();
    const ack = vi.fn();
    const log = vi.fn();
    const res = await runOwnerPush({
      digest: async () => digest,
      ack,
      send,
      dryRun: () => true,
      log,
    });
    expect(res).toEqual({ status: "dry_run" });
    expect(send).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining(digest.text));
  });
});

describe("Telegram sender (Env Catalog, no secrets in code)", () => {
  const secretsOf = (entries: Record<string, string>) => ({
    record: async (name: string) => (name in entries ? { value: entries[name]! } : null),
  });

  it("posts to the bot's sendMessage in the topic of the chat", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const send = createTelegramSender({
      secrets: secretsOf({ [TG_TOKEN_NAME]: "tok:123", [TG_CHAT_NAME]: "-1009", [TG_TOPIC_NAME]: "42" }),
      fetchImpl: (async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), body: String(init?.body ?? "") });
        return new Response("{\"ok\":true}", { status: 200 });
      }) as typeof fetch,
    });
    await send("hello world");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.telegram.org/bottok:123/sendMessage");
    expect(calls[0]!.body).toContain("chat_id=-1009");
    expect(calls[0]!.body).toContain("message_thread_id=42");
  });

  it("names the missing catalog record and sends nothing", async () => {
    const fetchImpl = vi.fn();
    const send = createTelegramSender({
      secrets: secretsOf({ [TG_TOKEN_NAME]: "tok", [TG_CHAT_NAME]: "-1" }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(send("x")).rejects.toThrowError(TelegramNotReadyError);
    await expect(send("x")).rejects.toThrow(TG_TOPIC_NAME);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("an HTTP refusal throws without the token in the message", async () => {
    const send = createTelegramSender({
      secrets: secretsOf({ [TG_TOKEN_NAME]: "secret-tok", [TG_CHAT_NAME]: "-1", [TG_TOPIC_NAME]: "7" }),
      fetchImpl: (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch,
    });
    let err: unknown;
    try { await send("hi"); } catch (cause) { err = cause; }
    expect(err).toBeInstanceOf(TelegramSendError);
    expect(String(err)).toContain("502");
    expect(String(err)).not.toContain("secret-tok");
  });
});

describe("the compact SQLite daily digest", () => {
  it("summarizes 24h attempts, workflow runs, owner waiting, deferrals, and outages within 9 lines", async () => {
    const now = Date.parse("2026-11-15T09:00:00Z");
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);

    // Accepted + blocked real task attempts + excluded drill/sandbox attempts
    createRun(db, "r_real", "proj_a");
    createRun(db, "r_sand", "__drill_sandbox__");
    createAttempt(db, { id: "att_ok", runId: "r_real", taskId: "t1" });
    transitionAttempt(db, "att_ok", "spawn_requested");
    transitionAttempt(db, "att_ok", "running");
    transitionAttempt(db, "att_ok", "accepted");
    createAttempt(db, { id: "att_fail", runId: "r_real", taskId: "t2" });
    transitionAttempt(db, "att_fail", "blocked", { reason: "failed check" });
    createAttempt(db, { id: "att_drill", runId: "r_sand", taskId: "drill-1" });
    transitionAttempt(db, "att_drill", "blocked", { reason: "drill" });
    db.prepare("UPDATE lane_pilot_attempt SET updated_at=?").run(now - 1_500_000);

    // Workflow run + measured cost step
    const engine = new WorkflowEngine({ db, harnessVersion: "1.0.0", now: () => now - 900_000 });
    engine.register("lp.daily_report", {
      reentrant: true,
      run: async () => ({
        output: { sent: true, reason: "", day: "2026-11-15" },
        usage: { tokens: 100, costUsd: 1.25, costState: "measured" },
      }),
    });
    await engine.start({ workflow: dailyReportWorkflow, key: "digest-test-1" }).done;

    postOwnerItem(db, { key: "w1", source: "night", kind: "decision", what: "Check PR", why: "needs input", reason: "decision" }, now - 500_000);
    insertDeferral(db, {
      id: "dfr_1", projectId: "proj_a", kind: "gate", area: "", state: "open", what: "Defer check",
      dueAt: now + 86_400_000, dueSource: "explicit",
      ownerRef: { threadId: "thr_owner", seq: 1, index: 0, sha256: "x", at: 1 },
      ownerQuote: "tomorrow",
      history: [], source: "test", createdAt: now - 500_000, updatedAt: now - 500_000, closedAt: null, closedBy: null,
    });
    insertOutage(db, { fromAt: now - 600_000, toAt: now - 300_000, minutes: 5 }, "restart", now - 300_000);

    const text = await buildDailyReport({ db, now: () => now });
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    expect(lines.length).toBeLessThanOrEqual(9);
    expect(text).toContain("Попытки: принято 1, не прошло 1 (всего 2)");
    expect(text).toContain("Графы: запусков 1 (успешно 1, сбой 0)");
    expect(text).toContain("Расходы (24ч): $1.25");
    expect(text).toContain("Ждут владельца: 1");
    expect(text).toContain("Отсрочки: открыто 1");
    expect(text).toContain("Простои: 1");
  });

  it("renders not_measured workflow cost as не измерено and never prints 0", async () => {
    const now = Date.parse("2026-11-15T09:00:00Z");
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const engine = new WorkflowEngine({ db, harnessVersion: "1.0.0", now: () => now - 900_000 });
    engine.register("lp.daily_report", {
      reentrant: true,
      run: async () => ({
        output: { sent: true, reason: "", day: "2026-11-15" },
        usage: { unknown: true },
      }),
    });
    await engine.start({ workflow: dailyReportWorkflow, key: "digest-unmeasured-1" }).done;

    const text = await buildDailyReport({ db, now: () => now });
    const costLine = text.split("\n").find((line) => line.startsWith("Расходы"));
    expect(costLine).toBe("Расходы (24ч): не измерено");
    expect(costLine).not.toMatch(/\$?0\b/);
  });

  it("omits Отсрочки, Простои, and Дорожки when their counts are zero", () => {
    const text = composeDailyReport({
      day: "2026-11-15",
      accepted: 2,
      failed: 0,
      total: 2,
      workflowRuns: 3,
      workflowSucceeded: 3,
      workflowFailed: 0,
      costUsd: 0.4,
      costState: "measured",
      measuredSteps: 2,
      notMeasuredSteps: 0,
      waitingOpen: 0,
      waitingOverdue: 0,
      deferralsOpen: 0,
      deferralsOverdue: 0,
      outages: 0,
      paths: { candidates: 0, top: null },
    });
    expect(text).not.toContain("Дорожки");
    expect(text).not.toContain("Отсрочки");
    expect(text).not.toContain("Простои");
    expect(text.split("\n").length).toBeLessThanOrEqual(9);
  });

  it("renders the Дорожки discovery line after Ждут владельца, clips label to 40 chars, and keeps total <= 9 lines with all conditional lines", () => {
    const longLabel = "Export quarterly VAT ledger reconciliation report with detailed audit";
    const text = composeDailyReport({
      day: "2026-11-15",
      accepted: 2,
      failed: 1,
      total: 3,
      workflowRuns: 4,
      workflowSucceeded: 3,
      workflowFailed: 1,
      costUsd: 1.5,
      costState: "measured",
      measuredSteps: 3,
      notMeasuredSteps: 0,
      waitingOpen: 2,
      waitingOverdue: 1,
      deferralsOpen: 1,
      deferralsOverdue: 1,
      outages: 1,
      paths: { candidates: 4, top: { label: longLabel, count: 5 } },
    });
    const lines = text.split("\n");
    expect(lines.length).toBeLessThanOrEqual(9);
    const waitingIdx = lines.findIndex((line) => line.startsWith("Ждут владельца:"));
    expect(waitingIdx).toBeGreaterThanOrEqual(0);
    expect(lines[waitingIdx + 1]).toBe(`Дорожки: 4 кандидатов, топ: ${longLabel.slice(0, 40)} ×5`);
    expect(text).toContain("Отсрочки:");
    expect(text).toContain("Простои:");
  });

  it("reads path candidates from SQLite and omits the line with a WARN log if candidate reading fails", async () => {
    const now = Date.parse("2026-11-15T09:00:00Z");
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    recordRouteMiss(db, {
      projectId: "proj_a",
      source: "errand_route",
      kind: "no_candidate",
      brief: "Reconcile monthly Stripe payouts",
      now: now - 3_600_000,
    });
    recordRouteMiss(db, {
      projectId: "proj_a",
      source: "pm_route",
      kind: "weak_match",
      brief: "Reconcile monthly Stripe payouts",
      now: now - 1_800_000,
    });

    const withPaths = await buildDailyReport({ db, now: () => now });
    expect(withPaths).toContain("Дорожки: 1 кандидатов, топ: Reconcile monthly Stripe payouts ×2");
    expect(withPaths.split("\n").length).toBeLessThanOrEqual(9);

    const logs: string[] = [];
    const onFail = await buildDailyReport({
      db,
      now: () => now,
      log: (message) => logs.push(message),
      pathCandidates: () => {
        throw new Error("sqlite busy");
      },
    });
    expect(onFail).not.toContain("Дорожки");
    expect(logs).toContain("daily report paths failed: sqlite busy");
  });

  it("is due once a day, from nine o'clock in the owner's time zone", () => {
    const at = (iso: string) => Date.parse(iso);
    expect(dailyDue(at("2026-11-14T07:30:00Z"), "Europe/Madrid", null).due).toBe(false); // 08:30 CET
    expect(dailyDue(at("2026-11-14T08:00:00Z"), "Europe/Madrid", null)).toEqual({ due: true, day: "2026-11-14" });
    expect(dailyDue(at("2026-11-14T15:00:00Z"), "Europe/Madrid", "2026-11-14").due).toBe(false);
    expect(dailyDue(at("2026-11-15T08:00:00Z"), "Europe/Madrid", "2026-11-14").due).toBe(true);
  });
});

describe("report workflow actions (lp.owner-push and lp.daily-report)", () => {
  function mount(opts: { nowMs?: number; send?: (t: string) => Promise<void> } = {}) {
    let clock = opts.nowMs ?? Date.parse("2026-11-14T08:30:00Z"); // 09:30 Madrid
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const engine = new WorkflowEngine({ db, harnessVersion: "1.0.0", now: () => clock });
    const log = vi.fn();
    const ack = vi.fn();
    const sent: string[] = [];
    const send = opts.send ?? vi.fn(async (text: string) => { sent.push(text); });
    const ctx = {
      bb,
      db,
      secrets: { record: async () => null },
      isDisposed: () => false,
      log,
    };
    mountReports(ctx as never, {
      engine,
      digest: async () => digest,
      ack,
      send,
      now: () => clock,
    });
    return {
      db,
      engine,
      log,
      ack,
      send,
      sent,
      setNow: (ms: number) => { clock = ms; },
      runPush: () => engine.start({ workflow: ownerPushWorkflow, key: `push:${clock}` }).done,
      runDaily: () => engine.start({ workflow: dailyReportWorkflow, key: `daily:${clock}` }).done,
    };
  }

  it("lp.owner-push sends digest and acknowledges; dry_run only logs", async () => {
    const t = mount();
    await t.runPush();
    expect(t.sent).toEqual([digest.text]);
    expect(t.ack).toHaveBeenCalledWith(["k1", "k2"]);

    t.sent.length = 0;
    t.ack.mockClear();
    savePushConfig(t.db as never, { dry_run: "on" });
    t.setNow(t.engine.now() + 1_000);
    await t.runPush();
    expect(t.sent).toEqual([]);
    expect(t.ack).not.toHaveBeenCalled();
    expect(t.log).toHaveBeenCalledWith(expect.stringContaining(digest.text));
  });

  it("lp.daily-report sends once per local day, honors dry_run, and retries after send failures", async () => {
    const t = mount({ nowMs: Date.parse("2026-11-14T07:30:00Z") }); // 08:30 CET (before 09:00)
    await t.runDaily();
    expect(t.sent).toEqual([]);

    t.setNow(Date.parse("2026-11-14T08:05:00Z")); // 09:05 CET
    await t.runDaily();
    expect(t.sent).toHaveLength(1);
    const stored = t.db.prepare("SELECT value FROM lane_pilot_owner_config WHERE key=?").get(DAILY_SENT_KEY) as { value: string };
    expect(stored.value).toBe("2026-11-14");

    // Second run same day skips
    t.setNow(Date.parse("2026-11-14T10:05:00Z"));
    await t.runDaily();
    expect(t.sent).toHaveLength(1);

    // Dry run uses DAILY_DRY_KEY
    savePushConfig(t.db as never, { dry_run: "on" });
    t.setNow(Date.parse("2026-11-15T08:05:00Z"));
    await t.runDaily();
    expect(t.sent).toHaveLength(1);
    const dryMark = t.db.prepare("SELECT value FROM lane_pilot_owner_config WHERE key=?").get(DAILY_DRY_KEY) as { value: string };
    expect(dryMark.value).toBe("2026-11-15");

    // Not-ready Telegram does not mark sent so retry succeeds
    const tFail = mount({
      nowMs: Date.parse("2026-11-14T08:05:00Z"),
      send: async () => { throw new TelegramNotReadyError([TG_TOKEN_NAME]); },
    });
    await tFail.runDaily();
    expect(tFail.db.prepare("SELECT value FROM lane_pilot_owner_config WHERE key=?").get(DAILY_SENT_KEY)).toBeUndefined();
    expect(tFail.log).toHaveBeenCalledWith(expect.stringContaining("telegram_not_ready"));
  });

  it("the push settings carry dry_run next to the old keys", () => {
    const db = new Database(":memory:");
    db.exec("create table lane_pilot_owner_config(key text primary key, value text not null, updated_at integer not null)");
    expect(loadPushConfig(db as never).dryRun).toBeUndefined();
    expect(savePushConfig(db as never, { dry_run: "on" }).dryRun).toBe(true);
    expect(() => savePushConfig(db as never, { dry_run: "maybe" })).toThrow("on or off");
  });
});
