import { describe, expect, it } from "vitest";
import { compareArms, renderComparison, summarizeArm, wilsonInterval } from "../../src/rooms/bench/compare";
import type { BenchResult } from "../../src/rooms/bench/store";

const row = (taskId: string, accepted: boolean): BenchResult => ({
  runId: "r", taskId, position: 1, state: accepted ? "accepted" : "not_accepted", accepted,
  benchTaskId: null, lpRunId: null, attempts: 1, stagesPassed: accepted ? 2 : 1, stagesFailed: accepted ? 0 : 1,
  tokens: 10, costUsd: 0.1, costState: "measured", seconds: 10, reason: null, recordedAt: 1,
});

const arm = (name: string, flags: boolean[]) => summarizeArm(name, [flags.map((accepted, index) => row(`t${index}`, accepted))]);

describe("bench comparison confidence interval", () => {
  it("puts a 95% interval on each arm and on the paired difference", () => {
    const none = wilsonInterval(0, 20);
    const all = wilsonInterval(20, 20);
    expect(none.low).toBe(0);
    expect(none.high).toBeLessThan(0.2);
    expect(all.low).toBeGreaterThan(0.8);
    const separated = compareArms(arm("A", Array(20).fill(false)), arm("B", Array(20).fill(true)));
    expect(separated.passCi.level).toBe(0.95);
    expect(separated.passCi.diff.low).toBeGreaterThan(0);
    const tied = compareArms(arm("A", Array(20).fill(true)), arm("B", Array(20).fill(true)));
    expect(tied.passCi.diff.low).toBeLessThanOrEqual(0);
    expect(tied.passCi.diff.high).toBeGreaterThanOrEqual(0);
    expect(renderComparison(separated)).toMatch(/95% CI/);
    expect(renderComparison(tied)).toMatch(/inside the noise/);
  });
});
