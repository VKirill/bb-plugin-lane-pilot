import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createAttempt, createRun, listCheckDurations, listCheckTimeouts, openDatabase, recordCheckDuration, transitionAttempt } from "../src/rooms/storage/database";
import { CHECK_TIMEOUT_CAP_SEC, checkTimeoutSec, historyTimeoutSec, p95 } from "../src/rooms/writer/check-timing";

describe("check timeout from history", () => {
  it("takes the nearest-rank 95th percentile", () => {
    expect(p95([])).toBe(0);
    expect(p95([5])).toBe(5);
    expect(p95(Array.from({ length: 20 }, (_, i) => (i + 1) * 1000))).toBe(19_000);
  });

  it("keeps the configured timeout until enough runs are known", () => {
    expect(historyTimeoutSec(120, [])).toBe(120);
    expect(historyTimeoutSec(120, [200_000, 200_000])).toBe(120);
  });

  it("is max(configured, p95 x 2), capped, and never below the configured value", () => {
    expect(historyTimeoutSec(120, [10_000, 12_000, 11_000])).toBe(120);
    expect(historyTimeoutSec(120, [100_000, 110_000, 90_000, 95_000])).toBe(220);
    expect(historyTimeoutSec(120, [2_000_000, 2_000_000, 2_000_000])).toBe(CHECK_TIMEOUT_CAP_SEC);
    expect(historyTimeoutSec(3600, [2_000_000, 2_000_000, 2_000_000])).toBe(3600);
  });

  it("reads the limits a command timed out at from the final reasons of its attempts, per project (a timeout is kept in no duration row)", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "runA", "A");
    createRun(db, "runB", "B");
    const attempt = (run:string, id:string, reason:string) => { createAttempt(db, { id, runId:run, taskId:id }); transitionAttempt(db, id, "blocked", { reason }); };
    attempt("runA", "a1", "verification failed (python3 -I scripts/studio_test.py): verification timed out after 120s");
    attempt("runA", "a2", "turn limit 5 reached: verification failed (python3 -I scripts/studio_test.py): verification timed out after 600s");
    attempt("runA", "a3", "verification failed (python3 -I scripts/studio_test.py): exit 1");
    attempt("runA", "a4", "verification failed (python3 -I scripts/studio_test.py --filter X): verification timed out after 90s");
    attempt("runB", "b1", "verification failed (python3 -I scripts/studio_test.py): verification timed out after 30s");
    expect(listCheckTimeouts(db, "A", "python3 -I scripts/studio_test.py").sort((a, b) => a - b)).toEqual([120, 600]);
    expect(listCheckTimeouts(db, "A", "python3 -I scripts/studio_test.py --filter X")).toEqual([90]);
    expect(listCheckTimeouts(db, "B", "python3 -I scripts/studio_test.py")).toEqual([30]);
    expect(listCheckTimeouts(db, "A", "npm test")).toEqual([]);
    // The same check started from its folder is the same history.
    expect(listCheckTimeouts(db, "A", "cd game && python3 -I scripts/studio_test.py").sort((a, b) => a - b)).toEqual([120, 600]);
    await harness.lifecycle.dispose();
  });

  it("stores each passing run per project and command and reads the last 20, newest first", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    for (let i = 1; i <= 25; i += 1) recordCheckDuration(db, { projectId: "A", command: "npm test", durationMs: i * 1000, exitCode: 0, now: i });
    recordCheckDuration(db, { projectId: "A", command: "npm run lint", durationMs: 7_000, exitCode: 0, now: 30 });
    recordCheckDuration(db, { projectId: "B", command: "npm test", durationMs: 9_000, exitCode: 0, now: 31 });
    // A red run ends early and says nothing about how long a green one takes.
    recordCheckDuration(db, { projectId: "A", command: "npm test", durationMs: 1, exitCode: 1, now: 32 });
    const rows = listCheckDurations(db, "A", "npm test");
    expect(rows).toHaveLength(20);
    expect(rows[0]).toBe(25_000);
    expect(rows[19]).toBe(6_000);
    expect(listCheckDurations(db, "A", "npm run lint")).toEqual([7_000]);
    expect(listCheckDurations(db, "B", "npm test")).toEqual([9_000]);
    await harness.lifecycle.dispose();
  });

  it("checkTimeoutSec widens a slow check from its own history and leaves a new one alone", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    expect(checkTimeoutSec(db, "A", "npm test", 120)).toBe(120);
    for (const ms of [100_000, 105_000, 110_000, 98_000]) recordCheckDuration(db, { projectId: "A", command: "npm test", durationMs: ms, exitCode: 0 });
    expect(checkTimeoutSec(db, "A", "npm test", 120)).toBe(220);
    expect(checkTimeoutSec(db, "B", "npm test", 120)).toBe(120);
    await harness.lifecycle.dispose();
  });
});

describe("one check whatever folder starts it", () => {
  it("shares its durations and timeouts with and without a leading cd (wc35ef88c-T1, 2026-10-26)", async () => {
    const { checkHistoryKey } = await import("../src/rooms/storage/database");
    expect(checkHistoryKey("cd game && python3 -I scripts/studio_test.py")).toBe(checkHistoryKey("python3  -I scripts/studio_test.py"));
    expect(checkHistoryKey("cd game && python3 -I scripts/studio_test.py --filter Par030")).not.toBe(checkHistoryKey("python3 -I scripts/studio_test.py"));
  });
});

