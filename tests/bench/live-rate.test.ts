import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isLiveProject, liveStability, renderLiveStability, type LiveAttempt } from "../../src/rooms/bench/live-rate";

const row = (over: Partial<LiveAttempt> & Pick<LiveAttempt, "taskId" | "state">): LiveAttempt => ({
  projectId: "proj_live", projectName: "SelfyStudio", reason: null, harnessVersion: "0.1.389", updatedAt: 1, ...over,
});

describe("live stability", () => {
  it("counts a task once, splits LP errors from task failures, and leaves sandboxes and old versions out", () => {
    expect(isLiveProject("proj_3tb652jpsi", "anything", "t")).toBe(false);
    expect(isLiveProject("proj_ibu6v9g64j", null, "t")).toBe(false);
    expect(isLiveProject("proj_live", "LP bench toy", "t")).toBe(false);
    expect(isLiveProject("proj_live", "SelfyStudio", "drill-1")).toBe(false);
    expect(isLiveProject("proj_live", "SelfyStudio", "task-1")).toBe(true);

    const report = liveStability([
      row({ taskId: "sand", projectId: "proj_3tb652jpsi", projectName: "LP sandbox", state: "accepted" }),
      row({ taskId: "drill2", projectId: "proj_ibu6v9g64j", state: "validation_failed", reason: "verification failed (1)" }),
      row({ taskId: "bench", projectName: "LP bench Selfy", state: "accepted" }),
      row({ taskId: "old", state: "accepted", harnessVersion: "0.1.100" }),
      row({ taskId: "gone", state: "validation_failed", reason: "verification failed", harnessVersion: null }),
      row({ taskId: "flip", state: "validation_failed", reason: "verification failed (1)", updatedAt: 1 }),
      row({ taskId: "flip", state: "accepted", updatedAt: 2 }),
      row({ taskId: "flip", state: "running", reason: null, updatedAt: 3 }),
      row({ taskId: "red", state: "validation_failed", reason: "verification failed (2): exit 1" }),
      row({ taskId: "scope", state: "blocked", reason: "outside owns_paths: src/x.ts" }),
      row({ taskId: "lp", state: "blocked", reason: "reconcile_lost" }),
      row({ taskId: "lp2", state: "blocked", reason: "internal_error: critic broken" }),
      row({ taskId: "wait", state: "blocked", reason: "writer_provider_unavailable:owner_present" }),
      row({ taskId: "check", state: "blocked", reason: "verification failed (1): critic broken" }),
    ], { floorVersion: "0.1.389" });

    expect(report.accepted).toBe(1);
    expect(report.taskFailures).toBe(3);
    expect(report.lpErrors).toBe(3);
    expect(report.tasks).toBe(7);
    expect(report.excluded.sandboxTasks).toBe(3);
    expect(report.excluded.oldVersionTasks).toBe(2);
    expect(renderLiveStability(report)).toMatch(/принято 1/);
    expect(renderLiveStability(report)).toMatch(/Ошибка LP: 3/);
    expect(renderLiveStability(report)).toMatch(/Провал задачи: 3/);
  });

  it("is what the wall and the daily summary ask for", () => {
    const wall = readFileSync(new URL("../../src/rooms/wall/server/wall.ts", import.meta.url), "utf8");
    const daily = readFileSync(new URL("../../scripts/lp-metrics-daily.sh", import.meta.url), "utf8");
    expect(wall).toContain("isLiveProject");
    expect(daily).toContain("print-live-stability.ts");
    expect(daily).not.toMatch(/Вина Lane Pilot \(harness\)/);
  });
});
