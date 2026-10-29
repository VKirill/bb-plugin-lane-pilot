import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { calibrate, scoreForecast } from "../../src/rooms/forecast/logic";
import { preship, receiptChain, verifyChain } from "../../src/rooms/receipts";
import { recordStage } from "../../src/rooms/runs/server/stage-records";
import { createAttempt, createRun, createTask, openDatabase } from "../../src/rooms/storage";

describe("receipts", () => {
  it("[sma:k_v_chain] a changed stage receipt moves the chain tip, and the old tip no longer verifies", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: { id: "t1" } as never });
    recordStage(db, { runId: "run1", taskId: "t1", stageId: "verification", state: "passed", input: "npm test", result: { exitCode: 0 } });
    const first = receiptChain(db, "run1", "t1");
    expect(verifyChain(db, "run1", "t1", first.tip)).toBe(true);
    db.prepare("UPDATE lane_pilot_stage_receipt SET state='failed' WHERE run_id='run1' AND task_id='t1'").run();
    const second = receiptChain(db, "run1", "t1");
    expect(second.tip).not.toBe(first.tip);
    expect(verifyChain(db, "run1", "t1", first.tip)).toBe(false);
    expect(verifyChain(db, "run1", "t1", second.tip)).toBe(true);
  });

  it("[sma:k_v_preship] an open attempt stops a clear ship, and a deferral the founder already kept does not", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: { id: "t1" } as never });
    createAttempt(db, { id: "a1", runId: "run1", taskId: "t1" });
    db.prepare("UPDATE lane_pilot_attempt SET state='running' WHERE id='a1'").run();
    const open = preship(db, "projA");
    expect(open.clear).toBe(false);
    expect(open.items.some((item) => item.what.includes("t1") && item.what.includes("running"))).toBe(true);
    db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='a1'").run();
    db.prepare("INSERT INTO lane_pilot_deferral(id, project_id, what, kind, state, created_at, updated_at) VALUES('d1','projA','wait for the owner','plan_decision','open',1,1)").run();
    const kept = preship(db, "projA");
    expect(kept.clear).toBe(true);
    expect(kept.items.map((item) => item.disposition)).toEqual(["keep with its term"]);
  });

  it.todo("[sma:k_v_receipthash] a done claim stores the command and the hash of the output it expected");

  it.todo("[sma:k_lib_consequences] a class A miss or a pass-then-fail stops shipping");

  it.todo("[sma:k_lib_footprint] files, lines and dependencies in the plan header are checked against the tree by arithmetic");
});

describe("forecasts", () => {
  it("[sma:k_v_predict] [sma:k_lib_predict] a forecast is scored by arithmetic, with no model", () => {
    const score = scoreForecast(
      { files: 2, checks_pass_first_try: true, tokens: 100, minutes: 10 },
      { files: 5, firstTry: false, tokens: 250, minutes: null },
    );
    expect(score.files).toEqual({ forecast: 2, fact: 5, error: 3 });
    expect(score.firstTry).toEqual({ forecast: true, fact: false, hit: false });
    expect(score.tokensRatio).toBe(2.5);
    expect(score.minutesRatio).toBeNull();
  });

  it("[sma:k_v_calibration] [sma:k_lib_calibration] verdicts are summed per area, and a weak area is visible", () => {
    const bad = scoreForecast({ files: 1, checks_pass_first_try: true }, { files: 4, firstTry: false, tokens: null, minutes: null });
    const good = scoreForecast({ files: 1, checks_pass_first_try: true }, { files: 1, firstTry: true, tokens: null, minutes: null });
    const report = calibrate([
      { area: "billing", score: bad },
      { area: "billing", score: bad },
      { area: "docs", score: good },
    ]);
    expect(report.overall?.tasks).toBe(3);
    expect(report.byArea[0]).toMatchObject({ area: "billing", tasks: 2, filesMae: 3, firstTryHit: 0 });
    expect(report.byArea[1]).toMatchObject({ area: "docs", tasks: 1, filesMae: 0, firstTryHit: 1 });
    expect(calibrate([])).toEqual({ overall: null, byArea: [] });
  });
});
