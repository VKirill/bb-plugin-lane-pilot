import { describe, expect, it } from "vitest";
import { stabilityMarks } from "../../src/rooms/bench/compare";
import { finishRunRow, insertSet, listResults, listStabilityMarks, saveResult, saveStabilityMarks, startRunRow } from "../../src/rooms/bench/store";
import { createBench } from "../../src/rooms/bench/service";
import { benchWorld } from "./helpers";
import type { ManifestTask } from "../../src/rooms/bench/types";

const task = (taskId: string, position: number): ManifestTask => ({
  taskId, position, projectId: "P", projectName: "P", hostId: "h", repoPath: "/repo", stratum: "small", hard: false, risk: "low", area: "a",
  initialHeadSha: "a".repeat(40), solutionCommit: "b".repeat(40), solutionPatchSha256: "c".repeat(64), contract: {},
  warm: { base: [], solution: [], discriminating: [], applied: "apply", files: [] },
});

type Db = ReturnType<typeof benchWorld>["db"];

function series(db: Db, setId: string, arm: string, repeat: number, outcomes: Record<string, boolean>): void {
  const run = startRunRow(db, { setId, arm, repeat, config: {}, budgetTokens: null, budgetHours: null });
  for (const [taskId, accepted] of Object.entries(outcomes)) {
    saveResult(db, {
      runId: run.id, taskId, position: 0, state: accepted ? "accepted" : "not_accepted", accepted,
      benchTaskId: `b-${taskId}`, lpRunId: null, attempts: 1, stagesPassed: 1, stagesFailed: 0,
      tokens: 10, costUsd: 0.01, costState: "measured", seconds: 10, reason: null, recordedAt: 1000,
    });
  }
  finishRunRow(db, run.id, "done", null);
}

function setup() {
  const { db } = benchWorld();
  const set = insertSet(db, { version: "v9", tasks: [task("t1", 1), task("t2", 2), task("t3", 3)], rejected: [], candidateCount: 3, config: {} });
  return { db, set };
}

describe("C5: task stability marks", () => {
  it("pass^N=1 graduates a task to regression, a mixed task is flaky, a consistent failure carries no mark", () => {
    const { db, set } = setup();
    // Arm A three repeats: t1 always accepted, t2 accepted once, t3 never.
    series(db, set.id, "A", 1, { t1: true, t2: true, t3: false });
    series(db, set.id, "A", 2, { t1: true, t2: false, t3: false });
    series(db, set.id, "A", 3, { t1: true, t2: false, t3: false });
    const runs = (db.prepare("SELECT id FROM lane_pilot_bench_run WHERE set_id=? AND arm=? ORDER BY repeat_no").all(set.id, "A") as Array<{ id: string }>).map((row) => row.id);
    const byRepeat = runs.map((runId) => listResults(db, runId));
    const stability = stabilityMarks(byRepeat);
    expect(stability.marks.get("t1")).toBe("regression");
    expect(stability.marks.get("t2")).toBe("flaky");
    expect(stability.marks.has("t3")).toBe(false);
    expect(stability.failedIds).toEqual(["t3"]);

    saveStabilityMarks(db, { setId: set.id, marks: stability.marks, dropIds: stability.failedIds });
    expect(listStabilityMarks(db, set.id)).toEqual(new Map([["t1", "regression"], ["t2", "flaky"]]));

    // A later night: t2 stabilized, t3 still fails every repeat — its old mark (if any) is dropped, t2 is promoted.
    saveStabilityMarks(db, { setId: set.id, marks: new Map([["t2", "regression"]]), dropIds: ["t3"] });
    expect(listStabilityMarks(db, set.id)).toEqual(new Map([["t1", "regression"], ["t2", "regression"]]));
  });

  it("a flagged flaky task does not enter the verdict even without a noise record", () => {
    const { db, set } = setup();
    // Arm A: all three pass. Arm B: t2 flips pass->fail; without the flaky flag that is a regression (fail verdict).
    series(db, set.id, "A", 1, { t1: true, t2: true, t3: true });
    series(db, set.id, "B", 1, { t1: true, t2: false, t3: true });
    const bench = createBench({ db: db as never, kv: { get: async () => undefined, set: async () => undefined }, host: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      pipeline: {} as never, projectNames: async () => new Map(), isSandboxName: () => false, log: () => undefined });

    const unflagged = bench.compare({ version: "v9", armA: "A", armB: "B" });
    expect(unflagged.comparison.verdict).toBe("fail");

    saveStabilityMarks(db, { setId: set.id, marks: new Map([["t2", "flaky"]]), dropIds: [] });
    const flagged = bench.compare({ version: "v9", armA: "A", armB: "B" });
    expect(flagged.comparison.verdict).toBe("pass");
    expect(flagged.comparison.flips.find((flip) => flip.taskId === "t2")?.unstable).toBe(true);
  });

  it("status exposes the regression part of the set", () => {
    const { db, set } = setup();
    saveStabilityMarks(db, { setId: set.id, marks: new Map([["t1", "regression"], ["t2", "flaky"]]), dropIds: [] });
    const bench = createBench({ db: db as never, kv: { get: async () => undefined, set: async () => undefined }, host: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      pipeline: {} as never, projectNames: async () => new Map(), isSandboxName: () => false, log: () => undefined });
    expect(bench.status("v9")[0]!.marks).toEqual({ regression: 1, flaky: 1 });
    expect(bench.show("v9")!.marks).toEqual({ regression: 1, flaky: 1 });
  });
});
