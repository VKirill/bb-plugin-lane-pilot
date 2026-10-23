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

describe("red checks that are not the run's composition (lprun_38203a8b, 2026-10-23: 13 red, none a break of the run)", () => {
  // The real case, cut down: a run of releases and a revert, checked five days later on a main with a PR and docs refreshes on top.
  const release = (version: string) => `node -e "const p=require('./package.json');if(p.version!=='${version}')process.exit(1)" && grep -q '## ${version}' CHANGELOG.md`;
  const runTasks = ["release-0.8.14", "release-0.8.15", "sheet-link-chips", "sheet-link-chips-revert", "studio-settings-i18n", "prototype-builder", "prototype-toolbar"];
  const i18n = "node --experimental-strip-types --test src/studio/i18n-coverage.test.ts src/studio/studio-panel.test.ts 'src/studio/prototype/*.test.ts'";
  const chips = "node --experimental-strip-types --test src/spreadsheet/link-chip.test.ts";
  const pass = {
    tasks: [
      { taskId: "release-0.8.15", checks: [{ command: release("0.8.15"), state: "red" }] },
      { taskId: "release-0.8.14", checks: [{ command: release("0.8.14"), state: "red" }] },
      { taskId: "sheet-link-chips", checks: [{ command: chips, state: "red" }] },
      { taskId: "studio-settings-i18n", checks: [{ command: i18n, state: "red" }] },
      { taskId: "prototype-builder", checks: [{ command: "node --test src/studio/prototype/builder.test.ts", state: "red" }] },
    ],
    findings: [
      // release 0.8.16 came with the owner's PR after the run: no task of the run
      { taskId: "release-0.8.15", command: release("0.8.15"), culpritCommit: "4880b9f30043a509e68c4d7a496195fe73303087", culpritTask: null, sharedFiles: [] },
      { taskId: "release-0.8.14", command: release("0.8.14"), culpritCommit: "bd53329c6875a6b06231bc28359896bbaaeab5e8", culpritTask: "release-0.8.15", sharedFiles: ["CHANGELOG.md", "package-lock.json", "package.json"] },
      { taskId: "sheet-link-chips", command: chips, culpritCommit: "e64b6b915c468cba9f343ae5b09d4444f617c8c3", culpritTask: "sheet-link-chips-revert",
        sharedFiles: ["src/spreadsheet/grid.tsx", "src/spreadsheet/link-chip.test.ts", "src/spreadsheet/link-chip.ts"] },
      // the nightly docs refresh, after the run
      { taskId: "studio-settings-i18n", command: i18n, culpritCommit: "432d7425d95b36ae5820e4f070511b19158f7a35", culpritTask: null, sharedFiles: [] },
      // a later task of the run that changed the code under the test but not the test: a real break of the composition
      { taskId: "prototype-builder", command: "node --test src/studio/prototype/builder.test.ts", culpritCommit: "a".repeat(40), culpritTask: "prototype-toolbar", sharedFiles: ["src/studio/prototype/builder.ts"] },
    ],
  };

  it("sets aside the reds by work outside the run and the checks a later task of the run rewrote, and fails on the real break", () => {
    const verdict = goalVerdict(pass, runTasks);
    expect(verdict.state).toBe("failed");
    expect(verdict.red).toEqual([{ taskId: "prototype-builder", command: "node --test src/studio/prototype/builder.test.ts", culpritCommit: "a".repeat(40), culpritTask: "prototype-toolbar" }]);
    expect(verdict.aside!.map((row) => [row.taskId, row.why])).toEqual([["release-0.8.15", "outside"], ["release-0.8.14", "rewritten"], ["sheet-link-chips", "rewritten"], ["studio-settings-i18n", "outside"]]);
    expect(verdict.detail).toContain("2 red by work outside the run (release-0.8.15 by 4880b9f300, studio-settings-i18n by 432d7425d9)");
    expect(verdict.detail).toContain("2 rewritten on purpose by a later task of the run (release-0.8.14 by release-0.8.15, sheet-link-chips by sheet-link-chips-revert)");
  });

  it("the incident itself, without the made-up break, is a passed goal; a red with no culprit or no run to compare still counts", () => {
    const real = { tasks: pass.tasks.slice(0, 4), findings: pass.findings.slice(0, 4) };
    expect(goalVerdict(real, runTasks)).toMatchObject({ state: "passed", red: [] });
    expect(goalVerdict(real).state).toBe("failed");
    const unknown = { tasks: [pass.tasks[1]!], findings: [{ ...pass.findings[1]!, culpritCommit: null, culpritTask: null }] };
    expect(goalVerdict(unknown, runTasks).state).toBe("failed");
    // a shared file the command names only as part of a longer name is no rewrite of the check
    const near = { tasks: [{ taskId: "sheet-link-chips", checks: [{ command: "node --test src/spreadsheet/link-chip.tsx.test.ts", state: "red" }] }],
      findings: [{ taskId: "sheet-link-chips", command: "node --test src/spreadsheet/link-chip.tsx.test.ts", culpritCommit: "e".repeat(40), culpritTask: "sheet-link-chips-revert", sharedFiles: ["src/spreadsheet/link-chip.tsx"] }] };
    expect(goalVerdict(near, runTasks).state).toBe("failed");
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
