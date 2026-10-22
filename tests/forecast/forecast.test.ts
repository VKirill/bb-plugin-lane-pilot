import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { TaskV2 } from "../../src/rooms/contracts";
import { calibrate, calibrationLine, scoreForecast } from "../../src/rooms/forecast";
import { forecastReport, runForecastCli } from "../../src/rooms/forecast/server";
import { createAttempt, createRun, createTask, openDatabase, transitionAttempt } from "../../src/rooms/storage/database";

const NOW = Date.parse("2026-10-23T10:00:00Z");

describe("scoring a forecast", () => {
  it("measures files, first try, and fact/forecast ratios; a missing side is null", () => {
    expect(scoreForecast({ files: 2, checks_pass_first_try: true, tokens: 100_000, minutes: 20 }, { files: 4, firstTry: false, tokens: 150_000, minutes: null })).toEqual({
      files: { forecast: 2, fact: 4, error: 2 }, firstTry: { forecast: true, fact: false, hit: false }, tokensRatio: 1.5, minutesRatio: null,
    });
  });

  it("calibrates per area and overall, and the PM gets a line only after three tasks", () => {
    const score = (forecast: number, fact: number, hit: boolean, tokens: number | null) => scoreForecast({ files: forecast, checks_pass_first_try: true, tokens: 100 }, { files: fact, firstTry: hit, tokens, minutes: null });
    const result = calibrate([
      { area: "page:/a", score: score(2, 3, true, 200) }, { area: "page:/a", score: score(2, 1, false, 100) },
      { area: "page:/a", score: score(1, 1, true, null) }, { area: null, score: score(5, 9, true, 300) },
    ]);
    expect(result.overall).toMatchObject({ area: "all", tasks: 4, filesMae: 1.5, filesBias: 1, firstTryHit: 0.75, tokensRatio: 2 });
    expect(result.byArea.map((row) => [row.area, row.tasks])).toEqual([["page:/a", 3], ["—", 1]]);
    expect(calibrationLine(result.byArea[0])).toBe("Your forecasts in page:/a (3 tasks): files off by 0.67 on average (bias 0), first-try right 67%, real effort ×1.5 the forecast.");
    expect(calibrationLine(result.byArea[1])).toBeNull();
    expect(calibrate([])).toEqual({ overall: null, byArea: [] });
  });
});

describe("the report from what is on record", () => {
  const contract = (id: string, extra: Partial<TaskV2> = {}): TaskV2 => ({
    schema_version: 2, id, title: id, risk: "low", lane: "writer", project_cwd: "/repo", read_first: [], interfaces: [], invariants: [], out_of_scope: [],
    expected_outputs: ["a.ts"], owns_paths: ["a.ts"], never_touch: [], depends_on: [], objective: "x", acceptance: ["y"], verify: "none", verification: [], area: "feature:x", ...extra,
  });
  function world() {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    createRun(db, "run1", "P", "bb", "/repo");
    const accept = (task: string, attempts: number, changed: string[]) => {
      for (let n = 1; n <= attempts; n++) {
        const id = `${task}-a${n}`;
        createAttempt(db, { id, runId: "run1", taskId: task });
        transitionAttempt(db, id, "spawn_requested");
        transitionAttempt(db, id, "running", { threadId: `thr_${id}` });
        if (n < attempts) transitionAttempt(db, id, "validation_failed", { reason: "boom" });
        else {
          transitionAttempt(db, id, "accepted");
          db.prepare("INSERT INTO lane_pilot_attempt_change(attempt_id,run_id,task_id,changed_json,recorded_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, "run1", task, JSON.stringify(changed.map((path) => ({ status: "M", path }))), NOW, NOW);
        }
      }
    };
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: contract("t1", { forecast: { files: 1, checks_pass_first_try: true } }) });
    accept("t1", 1, ["a.ts", "b.ts"]);
    createTask(db, { id: "t2", runId: "run1", kind: "bb", contract: contract("t2", { forecast: { files: 2, checks_pass_first_try: true } }) });
    accept("t2", 2, ["a.ts", "b.ts"]);
    createTask(db, { id: "t3", runId: "run1", kind: "bb", contract: contract("t3", { forecast: { files: 1, checks_pass_first_try: true } }) });
    createTask(db, { id: "t4", runId: "run1", kind: "bb", contract: contract("t4") });
    accept("t4", 1, ["a.ts"]);
    return db;
  }

  it("scores the accepted tasks with a forecast, counts the others as waiting, and never scores a task without one", () => {
    const report = forecastReport(world() as never, { projectId: "P" });
    expect(report.scored.map((row) => [row.taskId, row.score.files.error, row.score.firstTry.hit])).toEqual([["t1", 1, true], ["t2", 0, false]]);
    expect(report.waiting).toBe(1);
    expect(report.calibration.overall).toMatchObject({ tasks: 2, filesMae: 0.5, firstTryHit: 0.5 });
    expect(runForecastCli(world() as never, ["--project", "P"]).stdout).toContain("all: 2 tasks, files off by 0.5");
    expect(runForecastCli(world() as never, ["--days", "0"]).exitCode).toBe(1);
  });
});
