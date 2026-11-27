import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FAILED_ATTEMPT_STATES, OPEN_ATTEMPT_STATES } from "../src/rooms/contracts";
import { createCore } from "../src/rooms/core/server/core";
import { collectOwnerWaiting, postOwnerItem } from "../src/rooms/owner-waiting";
import { savePushConfig } from "../src/rooms/owner-waiting/server";
import { openDatabase } from "../src/rooms/plugin-db";
import { setRunSettingsScopes, createRun, createTask, createAttempt } from "../src/rooms/storage";
import { classifyOutcome, TASK_OUTCOMES } from "../src/rooms/runs";
import { consoleOverview, runsConsoleRpc } from "../src/rooms/runs/server";
import { specialistOverview, upsertCharter } from "../src/rooms/specialist/server";

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => {
  await dispose?.();
  dispose = null;
});

function setAttemptState(
  db: ReturnType<typeof openDatabase>,
  attemptId: string,
  state: string,
  updatedAt: number,
  createdAt: number = updatedAt - 10_000,
) {
  db.prepare("UPDATE lane_pilot_attempt SET state = ?, created_at = ?, updated_at = ? WHERE id = ?")
    .run(state, createdAt, updatedAt, attemptId);
}

describe("classifyOutcome", () => {
  it("classifies terminal states and returns null for open/unknown states", () => {
    expect(TASK_OUTCOMES).toEqual(["accepted", "reworked", "canceled", "failed"]);
    for (const open of OPEN_ATTEMPT_STATES) {
      expect(classifyOutcome({ finalState: open, attemptCount: 1 })).toBeNull();
    }
    expect(classifyOutcome({ finalState: "nonexistent", attemptCount: 1 })).toBeNull();

    expect(classifyOutcome({ finalState: "accepted", attemptCount: 1 })).toBe("accepted");
    expect(classifyOutcome({ finalState: "merged", attemptCount: 1 })).toBe("accepted");
    expect(classifyOutcome({ finalState: "accepted", attemptCount: 2 })).toBe("reworked");
    expect(classifyOutcome({ finalState: "merged", attemptCount: 3 })).toBe("reworked");
    expect(classifyOutcome({ finalState: "canceled", attemptCount: 1 })).toBe("canceled");
    expect(classifyOutcome({ finalState: "canceled", attemptCount: 2 })).toBe("canceled");

    for (const failed of FAILED_ATTEMPT_STATES) {
      expect(classifyOutcome({ finalState: failed, attemptCount: 1 })).toBe("failed");
    }
  });
});

describe("consoleOverview", () => {
  it("aggregates outcomes in Europe/Moscow around midnight UTC, active work, waiting, goals, and degrades safely on spend error", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);

    // 2026-11-28T01:00:00Z = 2026-11-28 04:00:00 in Europe/Moscow (UTC+3).
    const nowMs = Date.parse("2026-11-28T01:00:00Z");
    const mskNov27 = Date.parse("2026-11-27T20:30:00Z"); // 23:30 MSK on Nov 27
    const mskNov28 = Date.parse("2026-11-27T21:30:00Z"); // 00:30 MSK on Nov 28

    createRun(db, "run-1", "proj-1");
    setRunSettingsScopes(db, "run-1", ["section:sec-a"]);
    createRun(db, "run-2", "proj-1");
    setRunSettingsScopes(db, "run-2", ["section:sec-b"]);

    // Two tasks accepted on first try: one before Moscow midnight (Nov 27), one after (Nov 28).
    createTask(db, { id: "t-acc-1", runId: "run-1", kind: "bb", contract: { display_title: "First accepted" } });
    createAttempt(db, { id: "a-acc-1", runId: "run-1", taskId: "t-acc-1" });
    setAttemptState(db, "a-acc-1", "accepted", mskNov27);

    createTask(db, { id: "t-acc-2", runId: "run-1", kind: "bb", contract: { display_title: "Second accepted" } });
    createAttempt(db, { id: "a-acc-2", runId: "run-1", taskId: "t-acc-2" });
    setAttemptState(db, "a-acc-2", "accepted", mskNov28);

    // One task accepted after rework (2 attempts) on Nov 28 MSK.
    createTask(db, { id: "t-rework", runId: "run-1", kind: "bb", contract: { display_title: "Reworked task" } });
    createAttempt(db, { id: "a-rew-1", runId: "run-1", taskId: "t-rework" });
    setAttemptState(db, "a-rew-1", "validation_failed", mskNov27);
    createAttempt(db, { id: "a-rew-2", runId: "run-1", taskId: "t-rework" });
    setAttemptState(db, "a-rew-2", "accepted", mskNov28 + 60_000);

    // One canceled task on Nov 27 MSK.
    createTask(db, { id: "t-cancel", runId: "run-2", kind: "bb", contract: { display_title: "Canceled task" } });
    createAttempt(db, { id: "a-cancel", runId: "run-2", taskId: "t-cancel" });
    setAttemptState(db, "a-cancel", "canceled", mskNov27 - 60_000);

    // One failed (blocked) task on Nov 28 MSK.
    createTask(db, { id: "t-fail", runId: "run-1", kind: "bb", contract: { display_title: "Failed task" } });
    createAttempt(db, { id: "a-fail", runId: "run-1", taskId: "t-fail" });
    setAttemptState(db, "a-fail", "blocked", mskNov28 + 120_000);

    // One active task currently running (must appear in active, NOT in closedByDay).
    createTask(db, { id: "t-live", runId: "run-1", kind: "bb", contract: { display_title: "Active task" } });
    createAttempt(db, { id: "a-live", runId: "run-1", taskId: "t-live" });
    setAttemptState(db, "a-live", "running", nowMs - 5_000);

    // Seed specialist charters: one on track, one behind.
    const fiveDaysMs = 5 * 86_400_000;
    upsertCharter(db, {
      projectId: "proj-1",
      domain: "seo",
      approvedBy: "owner",
      nowMs: nowMs - fiveDaysMs,
      charter: {
        north_star: { metric_id: "organic_clicks", current: 70, target: 100, due: new Date(nowMs + fiveDaysMs).toISOString() },
      },
    });
    upsertCharter(db, {
      projectId: "proj-1",
      domain: "marketing",
      approvedBy: "owner",
      nowMs: nowMs - fiveDaysMs,
      charter: {
        north_star: { metric_id: "paid_leads", current: 20, target: 100, due: new Date(nowMs + fiveDaysMs).toISOString() },
      },
    });

    // Seed one owner-waiting item.
    postOwnerItem(db, {
      key: "owner:test:1",
      source: "night",
      kind: "decision",
      reason: "decision",
      projectId: "proj-1",
      what: "Approve budget",
      why: "Test",
      wake: true,
      evidence: [],
      actions: [],
    }, nowMs);

    const warnings: string[] = [];
    const debugs: string[] = [];

    const overview = consoleOverview(
      {
        db,
        money: {
          status: () => ({
            monthUsd: 12.5,
            series: [],
            table: [{ day: "2026-11-28", usd: 3.4, byProvider: {} }],
            byProvider: {},
            costState: "measured",
            estimated: 0,
            estimatedUsd: 0,
            estimatedAttempts: 0,
            silentAttempts: 0,
            silentUnknown: 0,
            cap: 50,
            capSet: true,
            unlimited: false,
            left: 37.5,
            specialistLedger: { spend24hUsd: 0, spend30dUsd: 0, llm30dUsd: 0, apiUnits30d: 0, byDomain: {} },
          }),
        },
        specialistOverview,
        collectOwnerWaiting: (d, n) => collectOwnerWaiting(d, n),
        tz: "Europe/Moscow",
        now: () => nowMs,
        log: { warn: (m) => warnings.push(m), debug: (m) => debugs.push(m) },
      },
      { projectId: "proj-1", days: 7 },
    );

    expect(warnings).toEqual([]);
    expect(debugs[0]).toMatch(/^\[console\] overview project=proj-1 days=7 active=1 ms=\d+$/);
    expect(overview.tz).toBe("Europe/Moscow");
    expect(overview.counts).toEqual({
      active: 1,
      waiting: 1,
      closedToday: 3, // Nov 28 MSK: t-acc-2 (accepted), t-rework (reworked), t-fail (failed)
      spendTodayUsd: 3.4,
      goalsOnTrack: 1,
      goalsTotal: 2,
    });
    expect(overview.active).toHaveLength(1);
    expect(overview.active[0]).toMatchObject({
      kind: "task",
      title: "Active task",
      projectId: "proj-1",
      taskId: "t-live",
      costUsd: null,
    });

    const nov27 = overview.closedByDay.find((b) => b.day === "2026-11-27");
    const nov28 = overview.closedByDay.find((b) => b.day === "2026-11-28");
    expect(nov27).toEqual({ day: "2026-11-27", accepted: 1, reworked: 0, canceled: 1, failed: 0 });
    expect(nov28).toEqual({ day: "2026-11-28", accepted: 1, reworked: 1, canceled: 0, failed: 1 });
    expect(overview.goals).toEqual([
      expect.objectContaining({ projectId: "proj-1", domain: "marketing", metric: "paid_leads", current: 20, target: 100, onTrack: false }),
      expect.objectContaining({ projectId: "proj-1", domain: "seo", metric: "organic_clicks", current: 70, target: 100, onTrack: true }),
    ]);
    expect(overview.costCoverage).toBe(0);

    // Section narrowing excludes run-2's canceled task.
    const secA = consoleOverview(
      {
        db,
        money: { status: () => { throw new Error("money down"); } },
        specialistOverview,
        collectOwnerWaiting: (d, n) => collectOwnerWaiting(d, n),
        tz: "Europe/Moscow",
        now: () => nowMs,
        log: { warn: (m) => warnings.push(m) },
      },
      { projectId: "proj-1", sectionId: "sec-a", days: 7 },
    );
    expect(secA.counts.spendTodayUsd).toBeNull();
    expect(secA.closedByDay.find((b) => b.day === "2026-11-27")).toEqual({
      day: "2026-11-27",
      accepted: 1,
      reworked: 0,
      canceled: 0,
      failed: 0,
    });
    expect(secA.counts.active).toBe(1);
    expect(secA.counts.waiting).toBe(1);
    expect(warnings).toContain("[console] overview part=spend failed: money down");
  });

  it("wires runsConsoleRpc using loadPushConfig timezone", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    savePushConfig(db, { timezone: "Europe/Moscow" });

    const ctx = createCore(bb, db);
    const warnSpy = vi.spyOn(bb.log, "warn");
    const handlers = runsConsoleRpc(ctx, {
      money: {
        status: () => {
          throw new Error("boom");
        },
      },
      specialistOverview,
      collectOwnerWaiting: (d, n) => collectOwnerWaiting(d, n),
    });

    const out = await handlers.console_overview({ days: 7 });
    expect(out.tz).toBe("Europe/Moscow");
    expect(out.counts.spendTodayUsd).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[console] overview part=spend failed: boom"));
  });
});
