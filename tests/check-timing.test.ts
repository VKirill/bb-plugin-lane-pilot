import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { listCheckDurations, openDatabase, recordCheckDuration } from "../src/rooms/storage/database";
import { CHECK_TIMEOUT_CAP_SEC, checkTimeoutSec, historyTimeoutSec, p95 } from "../src/check-timing";

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
