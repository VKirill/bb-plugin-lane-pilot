import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { goalVerdict, pmGoalMessage, runReady } from "../../src/rooms/run-goal";
import { createRunGoal } from "../../src/rooms/run-goal/server";
import { createAttempt, createRun, createTask, openDatabase, setRunThread, transitionAttempt } from "../../src/rooms/storage/database";
import { runRunGoalCli } from "../../src/rooms/run-goal/server";

describe("when a run is done and what its checks together mean", () => {
  it("a run is ready with every task accepted or canceled and two accepted", () => {
    expect(runReady([{ taskId: "a", state: "accepted" }, { taskId: "b", state: "accepted" }, { taskId: "c", state: "canceled" }])).toBe(true);
    expect(runReady([{ taskId: "a", state: "accepted" }, { taskId: "b", state: "canceled" }])).toBe(false);
    expect(runReady([{ taskId: "a", state: "accepted" }, { taskId: "b", state: "accepted" }, { taskId: "c", state: "running" }])).toBe(false);
    expect(runReady([])).toBe(false);
  });

  it("passes with every check green, fails with the red ones and bisect's culprit, skips when nothing ran", () => {
    const tasks = [{ taskId: "a", checks: [{ command: "npm test -- a", state: "green" }] }, { taskId: "b", checks: [{ command: "npm test -- b", state: "red" }] }];
    expect(goalVerdict({ tasks: [tasks[0]!], findings: [] })).toEqual({ state: "passed", red: [], detail: null });
    expect(goalVerdict({ tasks, findings: [{ taskId: "b", command: "npm test -- b", culpritCommit: "abcdef1234567", culpritTask: "a" }] }))
      .toEqual({ state: "failed", red: [{ taskId: "b", command: "npm test -- b", culpritCommit: "abcdef1234567", culpritTask: "a" }], detail: null });
    expect(goalVerdict({ skipped: "the project folder is not a git checkout", tasks, findings: [] })).toMatchObject({ state: "skipped", detail: "the project folder is not a git checkout" });
    expect(goalVerdict({ tasks: [{ taskId: "a", checks: [], skipped: "the contract names no verification[]" }], findings: [] })).toMatchObject({ state: "skipped" });
    expect(pmGoalMessage("run1", [{ taskId: "b", command: "npm test -- b", culpritCommit: "abcdef1234567", culpritTask: "a" }])).toContain("- b: npm test -- b (сломал abcdef1234, задача a)");
  });
});

describe("the sweep", () => {
  function world(red: boolean) {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const sent: string[] = [];
    harness.sdk.stub("threads.send", async (args: { input: Array<{ text: string }> }) => { sent.push(args.input[0]!.text); return undefined; });
    const db = openDatabase(bb);
    createRun(db, "run1", "P", "bb", "/repo");
    setRunThread(db, "run1", "thr_pm");
    for (const id of ["t1", "t2"]) {
      createTask(db, { id, runId: "run1", kind: "bb", contract: {} as never });
      createAttempt(db, { id: `${id}-a1`, runId: "run1", taskId: id });
      transitionAttempt(db, `${id}-a1`, "spawn_requested");
      transitionAttempt(db, `${id}-a1`, "running", { threadId: `thr_${id}` });
      transitionAttempt(db, `${id}-a1`, "accepted");
    }
    createRun(db, "run2", "P", "bb", "/repo");
    createTask(db, { id: "t3", runId: "run2", kind: "bb", contract: {} as never });
    const calls: Array<{ runId?: string }> = [];
    const regression = { run: async (options: { runId?: string }) => {
      calls.push(options);
      return { projects: [{ head: "f".repeat(40), tasks: [{ taskId: "t1", checks: [{ command: "check t1", state: "green" }] }, { taskId: "t2", checks: [{ command: "check t2", state: red ? "red" : "green" }] }],
        findings: red ? [{ taskId: "t2", command: "check t2", culpritCommit: "c".repeat(40), culpritTask: "t1" }] : [] }] };
    } };
    const ctx = { db, bb, log: () => undefined, isDisposed: () => false };
    const api = createRunGoal(ctx as never, { regression } as never).runGoal;
    return { api, sent, calls };
  }

  it("checks each finished run once, keeps the verdict and tells the PM about a broken composition", async () => {
    const { api, sent, calls } = world(true);
    const first = await api.sweep();
    expect(first.map((row) => [row.runId, row.state, row.tasks])).toEqual([["run1", "failed", 2]]);
    expect(calls).toEqual([expect.objectContaining({ projectId: "P", runId: "run1", force: true })]);
    expect(sent[0]).toContain("задачи запуска run1 приняты каждая по отдельности");
    expect(await api.sweep()).toEqual([]);
    expect(api.status("run1")).toMatchObject({ state: "failed", red: [{ taskId: "t2", culpritTask: "t1" }] });
    expect(api.status("run2")).toBeNull();
  });

  it("a green composition is a passed verdict and no message; the command line reads and checks", async () => {
    const { api, sent } = world(false);
    expect((await api.sweep())[0]).toMatchObject({ state: "passed" });
    expect(sent).toEqual([]);
    expect(JSON.parse((await runRunGoalCli(api, ["--status", "run1"])).stdout!)).toMatchObject({ state: "passed" });
    expect((await runRunGoalCli(api, ["nope"])).exitCode).toBe(1);
    expect((await runRunGoalCli(api, [])).exitCode).toBe(1);
  });
});
