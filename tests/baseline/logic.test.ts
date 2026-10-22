import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  baselineVerdict, bisectCommand, bisectStepsFor, estimateSec, messageOwner, parseBaselineSettings, parseRegressSettings, planChecks, turnedRed, type BaselineCheck,
} from "../../src/rooms/baseline/logic";

const item = (command: string, extra: Record<string, unknown> = {}) => ({ command, cwd: "/p", ...extra }) as never;
const check = (command: string, status: BaselineCheck["status"]): BaselineCheck => ({ command, cwd: "/p", status, exitCode: status === "green" ? 0 : status === "red" ? 1 : null, note: "" });

describe("baseline and regression settings", () => {
  it("default to notify, a 300 s cap, a nightly pass over 30 tasks of 14 days", () => {
    expect(parseBaselineSettings({})).toEqual({ mode: "notify", timeCapSec: 300 });
    expect(parseRegressSettings({})).toEqual({ nightly: true, lastN: 30, days: 14, checkCapSec: 120, budgetSec: 1800, bisectSteps: 9 });
  });
  it("read stop, 0 as off, numeric strings, and fall back on nonsense instead of failing a task", () => {
    expect(parseBaselineSettings({ "baseline.already_built": "stop", "baseline.time_cap_sec": "0" })).toEqual({ mode: "stop", timeCapSec: 0 });
    expect(parseBaselineSettings({ "baseline.already_built": "maybe", "baseline.time_cap_sec": "soon" })).toEqual({ mode: "notify", timeCapSec: 300 });
    expect(parseBaselineSettings({ "baseline.time_cap_sec": 99999 }).timeCapSec).toBe(3600);
    expect(parseRegressSettings({ "regress.nightly": "off", "regress.last_n": "5", "regress.last_days": 3, "regress.bisect_steps": 99 })).toMatchObject({ nightly: false, lastN: 5, days: 3, bisectSteps: 14 });
  });
});

describe("which checks are cheap", () => {
  it("estimates from the p95 of green runs when there are three, else a nominal 30 s (or the configured limit when lower)", () => {
    expect(estimateSec([4000, 5000], 120)).toBe(30);
    expect(estimateSec([], 10)).toBe(10);
    expect(estimateSec([4000, 5000, 9000], 120)).toBe(9);
  });
  it("skips checks with secrets and slow ones, takes the rest while their estimates fit the cap, and charges nothing for a known answer", () => {
    const items = [item("a"), item("b", { secrets: ["TOKEN"] }), item("c"), item("d"), item("known")];
    const estimates: Record<string, number> = { a: 100, b: 1, c: 400, d: 150, known: 500 };
    const plan = planChecks(items, (it) => estimates[(it as { command: string }).command]!, { totalCapSec: 300, perCheckCapSec: 300, free: (it) => (it as { command: string }).command === "known" });
    expect(plan.map((row) => row.skip === null)).toEqual([true, false, false, true, true]);
    expect(plan[1]!.skip).toContain("secrets");
    expect(plan[2]!.skip).toContain("too slow");
    expect(planChecks(items.slice(0, 1).concat(items.slice(3, 4)), (it) => estimates[(it as { command: string }).command]!, { totalCapSec: 200, perCheckCapSec: 200 })[1]!.skip).toContain("over the time cap");
  });
});

describe("what the baseline says", () => {
  it("claims «already built» only when every check ran and passed", () => {
    expect(baselineVerdict([check("a", "green"), check("b", "green")])).toBe("already_built");
    expect(baselineVerdict([check("a", "green"), check("b", "skipped")])).toBe("partial");
    expect(baselineVerdict([check("a", "green"), check("b", "red")])).toBe("partial");
    expect(baselineVerdict([check("a", "red"), check("b", "red")])).toBe("red");
    expect(baselineVerdict([check("a", "skipped")])).toBe("unknown");
    expect(baselineVerdict([])).toBe("unknown");
  });
  it("names the checks that were green on the base and are red after, and ignores a check the host could not run", () => {
    const base = [check("a", "green"), check("b", "red"), check("c", "green"), check("d", "green")];
    expect(turnedRed(base, [{ command: "a", exitCode: 1 }, { command: "b", exitCode: 1 }, { command: "c", exitCode: 0 }, { command: "d", exitCode: 1, hostError: true }])).toEqual(["a"]);
  });
});

describe("the bisect command and the blame", () => {
  it("exits 0 for green and 1 for red, whatever the check exits with, in the check's folder", () => {
    for (const [command, expected] of [["exit 0", 0], ["exit 3", 1], ["exit 125", 1], ["exit 200", 1], ["echo \"it's\" && true", 0]] as const) {
      const ran = spawnSync("bash", ["-c", bisectCommand("", command)]);
      expect(ran.status, command).toBe(expected);
    }
    expect(spawnSync("bash", ["-c", bisectCommand("no/such/folder", "true")]).status).toBe(125);
    expect(spawnSync("bash", ["-c", bisectCommand("/tmp", "test \"$(pwd -P)\" = \"$(cd /tmp && pwd -P)\"")]).status).toBe(0);
  });
  it("reads the owner of a commit from the attempt trailer or the task id that starts the subject", () => {
    expect(messageOwner("t1: title\n\nLane-Pilot-Attempt: lpattempt_abc")).toEqual({ attemptId: "lpattempt_abc", taskId: "t1" });
    expect(messageOwner("fix the thing")).toEqual({ attemptId: null, taskId: null });
  });
  it("needs log2 steps", () => {
    expect([0, 1, 2, 3, 8, 9, 512].map(bisectStepsFor)).toEqual([0, 0, 1, 2, 3, 4, 9]);
  });
});
