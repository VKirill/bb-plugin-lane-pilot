import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import { createAttempt, createRun, openDatabase } from "../../src/database";
import { CANARY_MAX_ATTEMPTS, canaryAlertText, canaryReport, createCanary, rollbackCommand } from "../../src/server/canary";

const VERSION: string = packageJson.version;
const DAY = 86_400_000;

function setup() {
  const sent: Array<{ threadId: string; text: string }> = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "proj", "cli", "/repo");
  db.prepare("UPDATE lane_pilot_run SET pm_thread_id='pm-1' WHERE id='run'").run();
  let n = 0;
  /** A finished attempt under `version`, created `ageMs` ago. */
  const attempt = (state: string, reason: string | null = null, options: { version?: string; ageMs?: number } = {}) => {
    const id = `att-${++n}`;
    createAttempt(db, { id, runId: "run", taskId: `task-${n}` });
    db.prepare("UPDATE lane_pilot_attempt SET harness_version=?, created_at=? WHERE id=?").run(options.version ?? VERSION, Date.now() - (options.ageMs ?? 0), id);
    db.prepare("UPDATE lane_pilot_attempt SET state=?, reason=? WHERE id=?").run(state, reason, id);
    return id;
  };
  const kv = new Map<string, unknown>();
  const ctx = { bb: { storage: { kv: { get: async (key: string) => kv.get(key) ?? null, set: async (key: string, value: unknown) => { kv.set(key, value); } } },
    sdk: { threads: { send: async (args: { threadId: string; input: Array<{ text: string }> }) => { sent.push({ threadId: args.threadId, text: args.input[0]!.text }); return {}; } } },
    log: { warn: () => undefined, info: () => undefined } }, db, isDisposed: () => false, log: () => undefined } as never;
  return { db, harness, attempt, sent, canary: createCanary(ctx), kv };
}

const own = "internal_error: Cannot read properties of undefined";

describe("canaryReport on reasons from the hub", () => {
  it("a merge conflict with no file listed and a red check that printed EROFS are not faults of Lane Pilot", () => {
    const { db, attempt } = setup();
    for (let i = 0; i < 12; i += 1) attempt("accepted");
    for (let i = 0; i < 3; i += 1) attempt("validation_failed", "merge_conflict: main changed since this attempt started: ");
    for (let i = 0; i < 3; i += 1) attempt("blocked", "retry limit 2 exhausted: merge_conflict: main changed since this attempt started: ");
    attempt("blocked", "retry limit 2 exhausted: verification failed (npm -w @selfystudio/marketing run test -- ArticleBody): Error: EROFS: read-only file system, open '/x/node_modules/.vite-temp/v.mjs'");
    attempt("blocked", "attempt_worktree_holder_ambiguous:page_cap");
    const report = canaryReport(db, { version: VERSION, since: Date.now() - 3600_000, now: Date.now() });
    expect(report.budget).toMatchObject({ attempts: 20, faults: 1, exhausted: false });
  });
});

describe("canaryReport", () => {
  it("counts the own faults of the version's first attempts and trips on three above the budget", () => {
    const { db, attempt } = setup();
    for (let i = 0; i < 6; i += 1) attempt("accepted");
    attempt("blocked", own); attempt("blocked", own);
    expect(canaryReport(db, { version: VERSION, since: Date.now() - 3600_000, now: Date.now() })).toMatchObject({ faults: 2, tripped: false, window: { attempts: 8, open: true } });
    attempt("blocked", own);
    const report = canaryReport(db, { version: VERSION, since: Date.now() - 3600_000, now: Date.now() });
    expect(report).toMatchObject({ faults: 3, tripped: true });
    expect(report.rate).toBeCloseTo(3 / 9);
    expect(report.samples).toHaveLength(3);
  });

  it("does not count the task's own failures, the machine's, other versions' attempts or attempts from before the version started", () => {
    const { db, attempt } = setup();
    for (let i = 0; i < 4; i += 1) attempt("validation_failed", "verification failed (npm test): exited 1");
    for (let i = 0; i < 4; i += 1) attempt("blocked", "ENOSPC: no space left on device");
    for (let i = 0; i < 4; i += 1) attempt("blocked", own, { version: "0.0.1" });
    for (let i = 0; i < 4; i += 1) attempt("blocked", own, { ageMs: 5 * 3600_000 });
    attempt("running");
    const report = canaryReport(db, { version: VERSION, since: Date.now() - 3600_000, now: Date.now() });
    expect(report).toMatchObject({ faults: 0, tripped: false, window: { attempts: 8 } });
  });

  it("closes the window after the attempt count or the minutes, and stops counting at the window", () => {
    const { db, attempt } = setup();
    for (let i = 0; i < CANARY_MAX_ATTEMPTS; i += 1) attempt("accepted");
    for (let i = 0; i < 5; i += 1) attempt("blocked", own);
    const report = canaryReport(db, { version: VERSION, since: Date.now() - 3600_000, now: Date.now() });
    expect(report.window).toMatchObject({ open: false, attempts: CANARY_MAX_ATTEMPTS });
    expect(report.faults).toBe(0);
    expect(canaryReport(db, { version: VERSION, since: Date.now() - 3 * 3600_000, now: Date.now() }).window.open).toBe(false);
  });

  it("keeps the 7-day budget over every version and spends it above 5% with enough attempts", () => {
    const { db, attempt } = setup();
    for (let i = 0; i < 18; i += 1) attempt("accepted", null, { version: "0.0.1", ageMs: 2 * DAY });
    attempt("blocked", own, { version: "0.0.1", ageMs: 2 * DAY });
    attempt("blocked", own, { version: "0.0.1", ageMs: 20 * DAY });
    expect(canaryReport(db, { version: VERSION, since: Date.now(), now: Date.now() }).budget).toMatchObject({ attempts: 19, faults: 1, exhausted: false });
    attempt("blocked", own, { version: "0.0.1", ageMs: DAY });
    attempt("blocked", own, { version: "0.0.1", ageMs: DAY });
    const budget = canaryReport(db, { version: VERSION, since: Date.now(), now: Date.now() }).budget;
    expect(budget).toMatchObject({ attempts: 21, faults: 3, exhausted: true });
  });

  it("names the previous version and the rollback command", () => {
    const { db, attempt } = setup();
    attempt("accepted", null, { version: "0.0.9", ageMs: 5 * 3600_000 });
    const report = canaryReport(db, { version: VERSION, since: Date.now() - 3600_000, now: Date.now() });
    expect(report.previousVersion).toBe("0.0.9");
    expect(report.rollback).toBe(rollbackCommand("0.0.9"));
    expect(canaryReport(setup().db, { version: VERSION, since: 0, now: Date.now() }).rollback).toBeNull();
  });
});

describe("canary check", () => {
  it("tells the PM of the failed tasks once per version, with the rollback command, and stores nothing in the database", async () => {
    const { attempt, canary, sent, db } = setup();
    attempt("accepted", null, { version: "0.0.9", ageMs: 5 * 3600_000 });
    await canary.noteStart();
    for (let i = 0; i < 3; i += 1) attempt("blocked", own);
    const before = db.prepare("SELECT count(*) AS n FROM lane_pilot_attempt").get();
    expect(await canary.check()).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ threadId: "pm-1", text: expect.stringContaining("bash scripts/lp-canary.sh --rollback 0.0.9") });
    expect(sent[0]!.text).toContain("3 of the first 3 attempts");
    expect(await canary.check()).toBe(false);
    expect(sent).toHaveLength(1);
    expect(db.prepare("SELECT count(*) AS n FROM lane_pilot_attempt").get()).toEqual(before);
    expect((await canary.status()).alerted).toBe(true);
  });

  it("stays silent while the version is healthy", async () => {
    const { attempt, canary, sent } = setup();
    await canary.noteStart();
    for (let i = 0; i < 10; i += 1) attempt("accepted");
    attempt("blocked", own);
    expect(await canary.check()).toBe(false);
    expect(sent).toEqual([]);
  });

  it("alert text carries the count, the rate and a sample", () => {
    const text = canaryAlertText({ version: "0.1.9", since: 0, window: { open: true, attempts: 10, minutes: 5, maxAttempts: 20, maxMinutes: 120 }, faults: 4, rate: 0.4, tripped: true,
      samples: [{ projectId: "p", runId: "r", taskId: "T1", pmThreadId: "pm", reason: "merge_failed: x" }], budget: { days: 7, attempts: 10, faults: 4, rate: 0.4, limit: 0.05, exhausted: false },
      previousVersion: null, rollback: null });
    expect(text).toContain("4 of the first 10 attempts");
    expect(text).toContain("40%");
    expect(text).toContain("T1: merge_failed: x");
  });
});
