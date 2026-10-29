import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { baselineVerdict, type BaselineCheck } from "../../src/rooms/baseline/logic";
import { calibrationLine, calibrate, scoreForecast } from "../../src/rooms/forecast/logic";
import { prPassport } from "../../src/rooms/receipts";
import { recordStage } from "../../src/rooms/runs/server/stage-records";
import { createRun, createTask, openDatabase } from "../../src/rooms/storage";
import { brokenWireReason, readWires, wiresCommand } from "../../src/rooms/wires";

const check = (status: BaselineCheck["status"], command = "npm test"): BaselineCheck => ({
  command, cwd: "/repo", status, exitCode: status === "green" ? 0 : status === "red" ? 1 : null, note: "",
});

describe("wires and already-built", () => {
  it("[sma:k_v_wires] [sma:k_lib_wires] a declared wire is met only where one source file names both ends, and a missing hop is not called a pass", () => {
    const wires = [{ chain: ["ui.theme", "loadSettings", "ThemeProvider"], why: "the theme reaches the provider" }];
    expect(wiresCommand(wires)).toContain(":(exclude)*test*");
    const met = readWires(wires, "__lp_wire__ 0 0 src/theme.ts\n__lp_wire__ 0 1 src/provider.tsx\n");
    expect(met[0]!.broken).toBeNull();
    expect(met[0]!.hops.map((hop) => hop.file)).toEqual(["src/theme.ts", "src/provider.tsx"]);
    const broken = readWires(wires, "__lp_wire__ 0 0 src/theme.ts\n");
    expect(broken[0]!.broken).toEqual({ from: "loadSettings", to: "ThemeProvider", file: null });
    expect(brokenWireReason(broken)).toMatch(/loadSettings/);
  });

  it("[sma:k_lib_preflight] [sma:k_v_preflight] already built only when every check ran green; a skip does not dispatch on a green claim", () => {
    expect(baselineVerdict([check("green"), check("green", "npm run build")])).toBe("already_built");
    expect(baselineVerdict([check("green"), check("skipped")])).not.toBe("already_built");
    expect(baselineVerdict([check("red")])).toBe("red");
    expect(baselineVerdict([])).toBe("unknown");
  });
});

describe("passport and the PR pack", () => {
  it("[sma:k_lib_manifestlib] the pull-request pack is the task's own acceptance, checks and stage receipts", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: { display_title: "Sum", objective: "add", acceptance: ["2+2 is 4"], verification: [{ command: "npm test" }] } });
    recordStage(db, { runId: "run1", taskId: "t1", stageId: "verification", state: "failed", input: "npm test", result: { exitCode: 1 } });
    const body = prPassport(db, "run1", "t1");
    expect(body).toContain("## Sum");
    expect(body).toContain("2+2 is 4");
    expect(body).toContain("`npm test`");
    expect(body).toContain("verification: failed");
    expect(body).not.toContain("verification: passed");
  });

  it("[sma:k_lib_passport] the calibration line is a pure function of the scores, and it stays hidden under three tasks", () => {
    const score = scoreForecast({ files: 1, checks_pass_first_try: true, minutes: 10 }, { files: 3, firstTry: false, tokens: null, minutes: 20 });
    const few = calibrate([{ area: "billing", score }, { area: "billing", score }]);
    expect(calibrationLine(few.byArea[0])).toBeNull();
    const enough = calibrate([{ area: "billing", score }, { area: "billing", score }, { area: "billing", score }]);
    const line = calibrationLine(enough.byArea[0]);
    expect(line).toContain("billing (3 tasks)");
    expect(line).toBe(calibrationLine(enough.byArea[0]));
  });

  it.todo("[sma:k_v_manifest] manifest() is version and table count, not predictions, receipts, and a blind check");

  it.todo("[sma:k_v_passport] passport() has no badge and does not change when the model changes");

  it.todo("[sma:k_lib_modelver] there is no model-change guard; the calibration line hides only under three tasks");

  it.todo("[sma:k_lib_goodhart] referenceTestEdits is not a skeptic countersign, a receipt sample, or a near-miss channel");

  it.todo("[sma:k_lib_rollbackmark] messageOwner does not record why an accepted work was rolled back");

  it.todo("[sma:k_lib_grill] challenge_gate waits for a critic pass, not a refutation with evidence or a change");
});
