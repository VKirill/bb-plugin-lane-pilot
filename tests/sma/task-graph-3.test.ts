import { describe, expect, it } from "vitest";
import type { TaskV2 } from "../../src/rooms/contracts";
import {
  baselineVerdict, planChecks, redBeforeAndAfter, requiresRedOnBase, turnedRed, vacuousChecks, type BaselineCheck,
} from "../../src/rooms/baseline/logic";
import { FREE_CLASSES, failureClass, isEnvironmentCheckFailure, nextStep } from "../../src/rooms/runs/failure-class";
import { classifyWriterOutput, referenceTestEdits } from "../../src/rooms/tasks";

const root = "/tmp/sma-task";
const baseTask: TaskV2 = {
  schema_version: 2, display_title: "Тестовая задача", kind: "feature", area: "feature:sma", id: "sma-task", title: "SMA", risk: "low", lane: "writer", project_cwd: root,
  read_first: ["src/a.ts"], interfaces: ["i"], invariants: ["inv"], out_of_scope: ["out"], expected_outputs: ["src/b.ts"],
  owns_paths: ["src/"], never_touch: [".git/**"], depends_on: [], objective: "change a", acceptance: ["done"],
  verify: "tests", verification: [{ command: "npm test", cwd: root }],
};

const check = (command: string, status: BaselineCheck["status"]): BaselineCheck => ({ command, cwd: root, status, exitCode: status === "green" ? 0 : 1, note: "" });

describe("baseline, a receipt and a fault that is not the work", () => {
  it("[sma:ac_baseline] a promised check that carries a secret or exceeds the time cap is left out; the ones that fit run in contract order", () => {
    const items = [
      { command: "npm test", cwd: root },
      { command: "npm run secret", cwd: root, secrets: ["API_KEY"] },
      { command: "npm run slow", cwd: root },
      { command: "npm run e2e", cwd: root },
    ];
    const estimate = (item: { command: string }) => item.command.endsWith("slow") ? 90 : 20;
    const planned = planChecks(items, estimate, { totalCapSec: 30, perCheckCapSec: 60 });
    expect(planned.map((row) => [row.item.command, row.skip])).toEqual([
      ["npm test", null],
      ["npm run secret", "the check carries secrets"],
      ["npm run slow", "too slow for this pass (about 90s, cap 60s)"],
      ["npm run e2e", "over the time cap (30s)"],
    ]);
  });

  it("[sma:ag_moot] [sma:ap_already_built] «already done» needs a check that can go red; an all-green baseline does not prove the work", () => {
    const green = [check("npm test", "green")];
    expect(baselineVerdict(green)).toBe("already_built");
    expect(vacuousChecks(green).map((row) => row.command)).toEqual(["npm test"]);
    expect(baselineVerdict([check("npm test", "green"), check("npm run lint", "skipped")])).not.toBe("already_built");
    expect(vacuousChecks([check("npm test", "red")])).toEqual([]);
    expect(requiresRedOnBase("medium", { risk: "medium", kind: "feature" })).toBe(true);
    expect(requiresRedOnBase("medium", { risk: "medium", kind: "docs" })).toBe(false);
    expect(requiresRedOnBase("off", { risk: "critical", kind: "feature" })).toBe(false);
  });

  it("[sma:ag_diff] [sma:ap_prered] only a check that was green and is now red is a new regression; one that was already red is not", () => {
    const baseline = [check("npm test", "green"), check("npm run lint", "red")];
    const after = [
      { command: "npm test", exitCode: 1 },
      { command: "npm run lint", exitCode: 1 },
      { command: "npm run host", exitCode: 1, hostError: true as const },
    ];
    expect(turnedRed(baseline, after)).toEqual(["npm test"]);
    expect(redBeforeAndAfter(baseline, after)).toEqual(["npm run lint"]);
  });

  it("[sma:ag_test_edits] a test that already existed and was modified or deleted is named; a new test is not a reference edit", () => {
    expect(referenceTestEdits([
      { path: "tests/tax.test.ts", status: "M" },
      { path: "tests/old.test.ts", status: "D" },
      { path: "tests/new.test.ts", status: "A" },
      { path: "src/tax.ts", status: "M" },
    ])).toEqual(["tests/tax.test.ts", "tests/old.test.ts"]);
  });

  it("[sma:ag_receiptless] a task with no check recipe is accepted from its files; one that promised checks and ran none is refused", () => {
    const produced = { task: baseTask, produced: ["src/b.ts"], contents: { "src/b.ts": "export const n = 1;\n" } };
    const none = classifyWriterOutput({ ...produced, task: { ...baseTask, verify: "none", verification: [] } });
    expect(none.ok).toBe(true);
    const owed = classifyWriterOutput({ ...produced, task: { ...baseTask, verification: [] } });
    expect(owed.ok).toBe(false);
    if (!owed.ok) expect(owed.reason).toContain("verification[] is empty");
  });

  it("[sma:ag_env] a check the machine broke is an environment fault; a check that reports a failing test is the work", () => {
    expect(isEnvironmentCheckFailure({ stderr: "EACCES: permission denied, rmSync '/work/.output'" })).toBe(true);
    expect(isEnvironmentCheckFailure({ stdout: "Tests  1 failed | 2 passed" })).toBe(false);
  });

  it("[sma:ag_infra] a disk-full or a failed spawn is the machine's, so the attempt is not spent and the task waits", () => {
    expect(failureClass("blocked", "ENOSPC: no space left on device")).toBe("infra");
    expect(FREE_CLASSES.has("infra")).toBe(true);
    expect(nextStep("blocked", "ENOSPC: no space left on device")).toContain("parked");
    expect(failureClass("blocked", "spawn failed: thread_provisioning_failed")).toBe("harness");
    expect(FREE_CLASSES.has("harness")).toBe(true);
  });
});

describe("gaps the code does not keep", () => {
  it.todo("[sma:ac_baseline_red] a red baseline asks a person before the attempt proceeds");
  it.todo("[sma:ag_infra] a vendor abort, a context overflow, a background tail and the turn ceiling are non-work stops");
  it.todo("[sma:as_launchable] the drawing and the consent are checked again between the person's yes and the launch");
  it.todo("[sma:ap_already_built] an already-green task is closed without a writer even when the baseline is set to notify");
});
