import { describe, expect, it } from "vitest";
import { buildSet } from "../../src/rooms/bench/build";
import { compareArms, computeNoise, renderComparison, summarizeArm } from "../../src/rooms/bench/compare";
import type { BenchProjectRef, Clock, PipelinePort } from "../../src/rooms/bench/ports";
import { aggregateAttempts, benchContract, prepareCheckoutCommand, runSeries } from "../../src/rooms/bench/runner";
import { createBench } from "../../src/rooms/bench/service";
import { getBenchProject, getRun, getSet, listResults, setBenchProject } from "../../src/rooms/bench/store";
import { isSandboxProjectName } from "../../src/rooms/stability/server";
import type { AttemptMetrics } from "../../src/rooms/usage/server/attempt-metrics";
import { benchWorld, git, localHost, makeContract, makeRepo, tmp } from "./helpers";
import type { BenchProject, Candidate } from "../../src/rooms/bench/types";

const BB = "proj_ejbam66722";

async function builtSet() {
  const { repo, bases } = makeRepo([{ file: "a.txt", attemptId: "att_a", taskId: "task-a" }, { file: "b.txt", attemptId: "att_b", taskId: "task-b" }, { file: "c.txt", attemptId: "att_c", taskId: "task-c" }]);
  const w = benchWorld();
  const names = ["a", "b", "c"];
  names.forEach((n, i) => w.accepted({ taskId: `task-${n}`, projectId: BB, base: bases[i]!, attemptId: `att_${n}`, attemptNo: n === "b" ? 2 : 1,
    contract: makeContract(repo, { read_first: ["README.md", ".agents/plans/missing.md"], display_title: undefined, kind: undefined, expected_outputs: [`${n}.txt`], owns_paths: [`${n}.txt`], verification: [{ command: `test -f ${n}.txt`, cwd: repo }, { command: `grep -q done ${n}.txt`, cwd: repo }] }) }));
  const projects: BenchProject[] = [{ projectId: BB, name: "BB-сервис", cwdPrefixes: [repo] }];
  const strata = [{ key: "bb-service", quota: 3, match: (c: Candidate) => c.projectId === BB }];
  const built = await buildSet({ db: w.db as never, host: localHost, version: "v1", strata, projects, hostFor: () => "local", scratch: tmp("lp-bench-scratch-"), minFreeGb: 0,
    projectNames: new Map([[BB, "BB-сервис"]]), isSandboxName: isSandboxProjectName });
  return { ...w, repo, projects, built, projectPath: tmp("lp-bench-project-") };
}

const attempt = (taskId: string, extra: Partial<AttemptMetrics> = {}): AttemptMetrics => ({
  taskId, attemptId: `${taskId}-1`, attemptNo: 1, state: "accepted", createdAt: 1, seconds: 100, stages: [], stagesPassed: 5, stagesFailed: 0, gates: { passed: 3, rejected: 0 },
  writer: { threadId: "thr", providerId: "codex", model: "gpt-6-luna" }, tokens: { input: 1_000_000, output: 10_000, cached: 500_000, total: 1_010_000 }, costUsd: 0.1, costState: "measured", costNote: null, ...extra,
});

/** A pipeline that answers from a table: which tasks the arm gets accepted, what each costs. */
function fakePipeline(project: BenchProjectRef, plan: (taskId: string) => { accepted: boolean; metrics?: Partial<AttemptMetrics> }) {
  const calls: { configure: unknown[]; dispatched: Record<string, unknown>[]; finished: string[] } = { configure: [], dispatched: [], finished: [] };
  const pipeline: PipelinePort = {
    findProject: async (name) => (name === project.name ? project : null),
    configure: async (_project, input) => { calls.configure.push(input); },
    startRun: async () => ({ pmThreadId: "pm", runId: "lprun" }),
    dispatch: async (_p, _pm, task) => { calls.dispatched.push(task); return { ok: true, detail: "queued" }; },
    outcome: async (_run, taskId) => ({ latestState: plan(taskId).accepted ? "accepted" : "blocked", attempts: 1 }),
    metrics: async (_p, _run, taskId) => [attempt(taskId, { state: plan(taskId).accepted ? "accepted" : "blocked", ...(plan(taskId).metrics ?? {}) })],
    cancel: async () => undefined, finishRun: async (_p, runId) => { calls.finished.push(runId); },
  };
  return { pipeline, calls };
}

const clock = (): Clock => { let t = 1_000_000; return { now: () => t, sleep: async (ms) => { t += ms; } }; };
const sourceId = (benchId: string) => ({ "01": "task-a", "02": "task-b", "03": "task-c" } as Record<string, string>)[benchId.slice(-2)]!;

describe("bench runner", () => {
  it("dispatches the same contracts moved to the clone, with frozen memory and an area of their own, and records the three numbers", async () => {
    const w = await builtSet();
    const project: BenchProjectRef = { projectId: "proj_bench", name: "LP bench BB-сервис / " + w.repo.split("/").pop(), hostId: "local", path: w.projectPath };
    const { pipeline, calls } = fakePipeline(project, () => ({ accepted: true }));
    const report = await runSeries({ db: w.db as never, host: localHost, pipeline, clock: clock(), projectNameFor: () => project.name }, { minFreeGb: 0, version: "v1", arm: "luna", repeat: 1, writer: { providerId: "codex", model: "gpt-6-luna" }, pollMs: 1 });
    expect(report).toMatchObject({ state: "done", tasks: 3, ran: 3, accepted: 3, skipped: 0 });

    const sent = calls.dispatched;
    expect(sent.map((t) => t.id)).toEqual(["bench-v1-luna-r1-01", "bench-v1-luna-r1-02", "bench-v1-luna-r1-03"]);
    for (const t of sent) {
      expect(t.project_cwd).toBe(w.projectPath);
      expect((t.verification as Array<{ cwd: string }>).every((v) => v.cwd === w.projectPath)).toBe(true);
      expect(String(t.area)).toMatch(/~b\d+lunar1$/);
      // The lint of today needs a card title and a kind; a file untracked in the live checkout is not in the clone and is left out of read_first.
      expect(t).toMatchObject({ display_title: "t", kind: "feature", read_first: ["README.md"] });
    }
    // Memory and rules are frozen: injection off, critics off, the writer is the arm's.
    expect(calls.configure[0]).toMatchObject({ harness: "none", settings: { "memory.enabled": false, "memory.inject": false, "memory.maintain": false, "writer.provider": "codex", "writer.model": "gpt-6-luna", "plan_critique.enabled": false } });
    expect(calls.finished).toEqual(["lprun"]);

    const results = listResults(w.db as never, getRun(w.db as never, getSet(w.db as never, "v1")!.id, "luna", 1)!.id);
    expect(results.map((r) => [r.accepted, r.stagesPassed, r.costState, r.seconds])).toEqual([[true, 5, "measured", 100], [true, 5, "measured", 100], [true, 5, "measured", 100]]);
    expect(results[0]!.costUsd).toBeCloseTo(0.1);
    // The clone of the task's base commit is where the pipeline works: each task reset it to its own base.
    expect(git(w.projectPath, "rev-parse", "HEAD")).toBe(git(w.projectPath, "rev-parse", "lp-bench"));
  });

  it("leaves code_critique.enabled unset when the arm moves critic.code.default_for_risk, so the arm's value can take effect", async () => {
    const w = await builtSet();
    const project: BenchProjectRef = { projectId: "proj_bench", name: "LP bench x", hostId: "local", path: w.projectPath };
    const { pipeline, calls } = fakePipeline(project, () => ({ accepted: true }));
    await runSeries({ db: w.db as never, host: localHost, pipeline, clock: clock(), projectNameFor: () => project.name }, { minFreeGb: 0, version: "v1", arm: "critic", limit: 1, settings: { "critic.code.default_for_risk": "medium" }, pollMs: 1 });
    const settings = (calls.configure[0] as { settings: Record<string, unknown> }).settings;
    expect(settings["critic.code.default_for_risk"]).toBe("medium");
    expect("code_critique.enabled" in settings).toBe(false);
    expect(settings["plan_critique.enabled"]).toBe(false);
  });

  it("does not run in a project that is not a bench project", async () => {
    const w = await builtSet();
    const real: BenchProjectRef = { projectId: "p", name: "SelfyStudio", hostId: "local", path: w.projectPath };
    const { pipeline } = fakePipeline(real, () => ({ accepted: true }));
    await expect(runSeries({ db: w.db as never, host: localHost, pipeline, clock: clock(), projectNameFor: () => "SelfyStudio" }, { minFreeGb: 0, version: "v1", arm: "x", pollMs: 1 })).resolves.toMatchObject({ state: "failed" });
  });

  it("stops the series before the token cap and resumes it without redoing finished tasks", async () => {
    const w = await builtSet();
    const project: BenchProjectRef = { projectId: "proj_bench", name: "LP bench x", hostId: "local", path: w.projectPath };
    const { pipeline, calls } = fakePipeline(project, () => ({ accepted: true }));
    const deps = { db: w.db as never, host: localHost, pipeline, clock: clock(), projectNameFor: () => project.name };
    // One task costs 1.01 M tokens; a 2.5 M cap lets two run (the third is expected to push past it).
    const first = await runSeries(deps, { version: "v1", minFreeGb: 0, arm: "capped", budgetTokens: 2_500_000, pollMs: 1 });
    expect(first).toMatchObject({ state: "stopped_budget", ran: 2, skipped: 1 });
    expect(first.stopReason).toMatch(/token budget/);
    expect(calls.dispatched).toHaveLength(2);
    const second = await runSeries(deps, { version: "v1", minFreeGb: 0, arm: "capped", budgetTokens: 10_000_000, pollMs: 1 });
    expect(second).toMatchObject({ state: "done", ran: 3, accepted: 3 });
    expect(calls.dispatched).toHaveLength(3);
  });

  it("stops before the hour cap, and a task that never ends is cancelled and counted not accepted", async () => {
    const w = await builtSet();
    const project: BenchProjectRef = { projectId: "proj_bench", name: "LP bench y", hostId: "local", path: w.projectPath };
    const slow = fakePipeline(project, () => ({ accepted: true, metrics: { seconds: 3600 } }));
    const hours = await runSeries({ db: w.db as never, host: localHost, pipeline: slow.pipeline, clock: clock(), projectNameFor: () => project.name }, { minFreeGb: 0, version: "v1", arm: "hours", budgetHours: 1.5, pollMs: 1 });
    expect(hours).toMatchObject({ state: "stopped_budget", ran: 1 });
    expect(hours.stopReason).toMatch(/time budget/);

    let cancelled = 0;
    const stuck: PipelinePort = { ...fakePipeline(project, () => ({ accepted: true })).pipeline, outcome: async () => ({ latestState: "running", attempts: 1 }), cancel: async () => { cancelled++; } };
    const out = await runSeries({ db: w.db as never, host: localHost, pipeline: stuck, clock: clock(), projectNameFor: () => project.name }, { minFreeGb: 0, version: "v1", arm: "stuck", only: ["task-a"], taskTimeoutMin: 1, pollMs: 20_000 });
    expect(out).toMatchObject({ accepted: 0, ran: 1 });
    expect(cancelled).toBe(1);
  });

  it("refuses a set whose rows were changed after the build", async () => {
    const w = await builtSet();
    w.db.exec("DROP TRIGGER lane_pilot_bench_task_frozen_u");
    w.db.prepare("UPDATE lane_pilot_bench_task SET initial_head_sha=? WHERE task_id='task-a'").run("f".repeat(40));
    const project: BenchProjectRef = { projectId: "p", name: "LP bench z", hostId: "local", path: w.projectPath };
    await expect(runSeries({ db: w.db as never, host: localHost, pipeline: fakePipeline(project, () => ({ accepted: true })).pipeline, clock: clock() }, { minFreeGb: 0, version: "v1", arm: "z" })).rejects.toThrow(/changed after it was written/);
  });
});

describe("bench contract and checkout", () => {
  it("applies the fault to the contract only", async () => {
    const w = await builtSet();
    const task = getSet(w.db as never, "v1")!.tasks[0]!;
    const plain = benchContract(task, { version: "v1", arm: "A b", repeat: 2, root: "/clone" });
    expect(plain).toMatchObject({ id: expect.stringMatching(/^bench-v1-a-b-r2-01$/), project_cwd: "/clone", depends_on: [] });
    expect(plain.owns_paths).toEqual(task.contract.owns_paths);
    expect(benchContract(task, { version: "v1", arm: "bad", repeat: 1, root: "/clone", fault: "owns" })).toMatchObject({ owns_paths: ["bench-fault/"], expected_outputs: ["bench-fault/unrelated.txt"] });
    expect(benchContract(task, { version: "v1", arm: "bad", repeat: 1, root: "/clone", fault: "read_first" })).toMatchObject({ read_first: ["package.json"] });
  });

  it("clones the repository once and resets it to each task's base commit", async () => {
    const { repo, bases } = makeRepo([{ file: "a.txt", attemptId: "x", taskId: "t1" }, { file: "b.txt", attemptId: "y", taskId: "t2" }]);
    const path = tmp("lp-bench-co-");
    const first = await localHost.run("h", "/", prepareCheckoutCommand(repo, path, bases[0]!), 60);
    expect(first.exitCode).toBe(0);
    expect(git(path, "rev-parse", "HEAD")).toBe(bases[0]);
    const second = await localHost.run("h", "/", prepareCheckoutCommand(repo, path, bases[1]!), 60);
    expect(second.exitCode).toBe(0);
    expect(git(path, "rev-parse", "HEAD")).toBe(bases[1]);
  });

  it("counts the attempts of a task: a rejected spawn costs nothing, a shared thread makes the cost partial, a provider without usage is not measured", () => {
    expect(aggregateAttempts([attempt("t"), attempt("t", { attemptId: "2", attemptNo: 2, costUsd: 0.2, tokens: { input: 0, output: 0, cached: 0, total: 5 } })])).toMatchObject({ attempts: 2, costState: "measured", costUsd: expect.closeTo(0.3), tokens: 1_010_005, stagesPassed: 10, seconds: 200 });
    expect(aggregateAttempts([attempt("t", { costState: "not_measured", costUsd: null, tokens: null })])).toMatchObject({ costState: "not_measured", costUsd: null, tokens: null });
    expect(aggregateAttempts([attempt("t"), attempt("t", { costState: "partial", costUsd: null, tokens: null })])).toMatchObject({ costState: "partial", costUsd: null });
    expect(aggregateAttempts([attempt("t", { writer: { threadId: null, providerId: null, model: null }, costState: "not_measured", costUsd: null, tokens: null })])).toMatchObject({ costState: "not_measured" });
  });

  it("keeps what an arm runs under per project, and the bench project names count as sandbox", () => {
    const w = benchWorld();
    expect(getBenchProject(w.db as never, "p")).toBeNull();
    setBenchProject(w.db as never, { projectId: "p", harness: "tree", sourceProjectId: "src" });
    setBenchProject(w.db as never, { projectId: "p", harness: "none", sourceProjectId: "src" });
    expect(getBenchProject(w.db as never, "p")).toEqual({ projectId: "p", harness: "none", sourceProjectId: "src" });
    expect(isSandboxProjectName("LP bench SelfyStudio")).toBe(true);
    expect(isSandboxProjectName("SelfyStudio")).toBe(false);
  });
});

describe("bench compare", () => {
  const rows = (accepted: boolean[], extra: Partial<{ stages: number; cost: number | null; seconds: number }> = {}) => accepted.map((ok, i) => ({
    runId: "r", taskId: `t${i + 1}`, position: i + 1, state: (ok ? "accepted" : "not_accepted") as "accepted" | "not_accepted", accepted: ok, benchTaskId: null, lpRunId: null, attempts: 1,
    stagesPassed: extra.stages ?? 5, stagesFailed: 0, tokens: extra.cost === null ? null : 1000, costUsd: extra.cost === undefined ? 1 : extra.cost,
    costState: (extra.cost === null ? "not_measured" : "measured") as "measured" | "not_measured", seconds: extra.seconds ?? 100, reason: null, recordedAt: 1,
  }));
  const arm = (name: string, ...repeats: ReturnType<typeof rows>[]) => summarizeArm(name, repeats);

  it("passes a change that is not worse, and lists a task that passed on A and fails on B as a regression", () => {
    const base = arm("A", rows([true, true, true, false]));
    expect(compareArms(base, arm("B", rows([true, true, true, false], { cost: 1.05, seconds: 105 }))).verdict).toBe("pass");
    const worse = compareArms(base, arm("B", rows([true, false, true, false])));
    expect(worse.verdict).toBe("fail");
    expect(worse.flips).toEqual([{ taskId: "t2", from: "pass", to: "fail", a: "1/1", b: "0/1", unstable: false }]);
    expect(worse.checks.find((c) => c.name === "no_regression")!.ok).toBe(false);
  });

  it("fails on stages, cost and time beyond 10%, and says so", () => {
    const base = arm("A", rows([true, true, true, true]));
    expect(compareArms(base, arm("B", rows([true, true, true, true], { stages: 4 }))).checks.find((c) => c.name === "stages")!.ok).toBe(false);
    expect(compareArms(base, arm("B", rows([true, true, true, true], { cost: 1.2 }))).checks.find((c) => c.name === "cost")!.ok).toBe(false);
    expect(compareArms(base, arm("B", rows([true, true, true, true], { seconds: 125 }))).checks.find((c) => c.name === "time")!.ok).toBe(false);
  });

  it("notes cost as not measured instead of reading it as zero", () => {
    const measured = arm("A", rows([true, true]));
    const unmeasured = arm("B", rows([true, true], { cost: null }));
    const result = compareArms(measured, unmeasured);
    expect(result.cost).toMatchObject({ a: null, b: null, pairedTasks: 0, notMeasured: ["t1", "t2"] });
    expect(result.checks.find((c) => c.name === "cost")!.detail).toMatch(/not measured/);
    expect(renderComparison(result)).toMatch(/not measured/);
  });

  it("calibrates the threshold on two identical runs: unstable tasks cannot fail the rule, cost and time noise widens the tolerance", () => {
    const a1 = arm("A1", rows([true, true, true, true], { cost: 1, seconds: 100 }));
    const a2 = arm("A2", rows([true, true, false, true], { cost: 1.3, seconds: 100 }));
    const noise = computeNoise(a1, a2);
    expect(noise.unstableTasks).toEqual(["t3"]);
    expect(noise.flipShare).toBeCloseTo(0.25);
    expect(noise.costRel).toBeCloseTo(0.2609, 3);
    const record = { id: "n", setId: "s", armA: "A1", armB: "A2", createdAt: 1, noise };
    const b = arm("B", rows([true, true, false, true], { cost: 1.2 }));
    // Without the baseline B fails (t3 passed on A1, +20% cost); with it the flip is noise and 20% is inside the measured spread.
    expect(compareArms(a1, b).verdict).toBe("fail");
    const calibrated = compareArms(a1, b, record);
    expect(calibrated.flips[0]).toMatchObject({ taskId: "t3", unstable: true });
    expect(calibrated.tolerance.cost).toBeCloseTo(0.2609, 3);
    expect(calibrated.verdict).toBe("pass");
  });

  it("reads repeats: a task passes on an arm when more than half of its repeats were accepted", () => {
    const two = arm("A", rows([true, true]), rows([true, false]));
    expect(two.tasks.get("t1")).toMatchObject({ repeats: 2, accepted: 2, passed: true });
    expect(two.tasks.get("t2")).toMatchObject({ repeats: 2, accepted: 1, passed: false });
  });
});

describe("bench compare: too little measured is inconclusive (review section 4)", () => {
  type Row = Parameters<typeof summarizeArm>[1][number][number];
  const row = (taskId: string, extra: Partial<Row> = {}): Row => ({
    runId: "r", taskId, position: 1, state: "accepted", accepted: true, benchTaskId: null, lpRunId: null, attempts: 1, stagesPassed: 5, stagesFailed: 0, tokens: 1000, costUsd: 1,
    costState: "measured", seconds: 100, reason: null, recordedAt: 1, ...extra,
  });
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i + 1}`);
  const all = (n: number, extra: Partial<Row> = {}) => ids(n).map((id) => row(id, extra));
  const skipped = (id: string) => row(id, { state: "skipped_budget", accepted: false, costState: "not_measured", costUsd: null, tokens: null, seconds: null });

  it("two empty arms: no pass on zero pairs", () => {
    const result = compareArms(summarizeArm("A", [[]]), summarizeArm("B", [[]]));
    expect(result).toMatchObject({ verdict: "inconclusive", pairedTasks: 0 });
    expect(result.checks.find((check) => check.name === "coverage")).toMatchObject({ ok: null });
    expect(renderComparison(result)).toMatch(/Verdict: INCONCLUSIVE/);
  });

  it("the night's comparison of the review: 8 asked, 2 paired, cost on 1: inconclusive, not a fail that blames three repairs", () => {
    const a = summarizeArm("night-0.1.305", [[row("t1"), row("t2", { costState: "not_measured", costUsd: null, tokens: null }), ...ids(8).slice(2).map(skipped)]]);
    const b = summarizeArm("night-0.1.328", [all(8)]);
    // B costs more than A on the one task measured on both, and passes fewer stages than a full A: a fail on that evidence alone.
    const result = compareArms(a, summarizeArm("night-0.1.328", [all(8, { costUsd: 5 })]));
    expect(result.pairedTasks).toBe(2);
    expect(result.cost.pairedTasks).toBe(1);
    expect(result.verdict).toBe("inconclusive");
    expect(result.checks.find((check) => check.name === "coverage")!.detail).toMatch(/2 paired tasks of 8 asked \(at least 4 needed\)/);
    expect(compareArms(a, b).verdict).toBe("inconclusive");
  });

  it("a cost or a time measured on fewer than two pairs compares nothing; a real regression with enough coverage still fails", () => {
    const base = summarizeArm("A", [all(4)]);
    const noCost = summarizeArm("B", [ids(4).map((id, i) => row(id, i === 0 ? {} : { costState: "not_measured", costUsd: null, tokens: null }))]);
    const result = compareArms(base, noCost);
    expect(result.checks.find((check) => check.name === "cost")).toMatchObject({ ok: null });
    expect(result.verdict).toBe("inconclusive");
    const noTime = summarizeArm("B", [ids(4).map((id, i) => row(id, i === 0 ? {} : { seconds: null }))]);
    expect(compareArms(base, noTime).checks.find((check) => check.name === "time")).toMatchObject({ ok: null });
    const regressed = summarizeArm("B", [ids(4).map((id, i) => row(id, i === 1 ? { state: "not_accepted", accepted: false } : {}))]);
    expect(compareArms(base, regressed).verdict).toBe("fail");              // four paired tasks, one regressed: enough to say worse
    expect(compareArms(base, regressed).checks.find((check) => check.name === "no_regression")).toMatchObject({ ok: false });
  });

  it("enough pairs with every measurement: pass and fail are as before", () => {
    const base = summarizeArm("A", [all(4)]);
    expect(compareArms(base, summarizeArm("B", [all(4)])).verdict).toBe("pass");
    expect(compareArms(base, summarizeArm("B", [all(4, { costUsd: 2 })])).verdict).toBe("fail");
  });

  it("an errored task is not a failure of the change, and an arm with one is not a finished measurement", () => {
    const base = summarizeArm("A", [all(4)]);
    const errored = summarizeArm("B", [[...all(3), row("t4", { state: "error", accepted: false, costState: "not_measured", costUsd: null, tokens: null, seconds: null })]]);
    expect(errored.errored).toEqual(["t4"]);
    expect(errored.tasks.has("t4")).toBe(false);
    const result = compareArms(base, errored);
    expect(result.verdict).toBe("inconclusive");
    expect(result.checks.find((check) => check.name === "no_regression")!.ok).toBe(true);
    expect(result.checks.find((check) => check.name === "coverage")!.detail).toMatch(/B: 1 task\(s\) errored/);
    const running = summarizeArm("B", [all(4)], ["repeat 1 is running"]);
    expect(compareArms(base, running).verdict).toBe("inconclusive");
  });
});

describe("a series with errored tasks is not done (review section 4)", () => {
  it("no bench project: every task errors and the series is failed, not done", async () => {
    const w = await builtSet();
    const project: BenchProjectRef = { projectId: "proj_bench", name: "LP bench missing", hostId: "local", path: w.projectPath };
    const pipeline: PipelinePort = { ...fakePipeline(project, () => ({ accepted: true })).pipeline, findProject: async () => null };
    const report = await runSeries({ db: w.db as never, host: localHost, pipeline, clock: clock(), projectNameFor: () => project.name }, { minFreeGb: 0, version: "v1", arm: "noproject", pollMs: 1 });
    expect(report).toMatchObject({ state: "failed", ran: 0, accepted: 0 });
    expect(getRun(w.db as never, getSet(w.db as never, "v1")!.id, "noproject", 1)!.state).toBe("failed");
  });

  it("the comparison of a stored series that failed or still runs says so", async () => {
    const w = await builtSet();
    const project: BenchProjectRef = { projectId: "proj_bench", name: "LP bench s2", hostId: "local", path: w.projectPath };
    const bench = createBench({ db: w.db as never, kv: { get: async () => undefined, set: async () => undefined }, host: localHost,
      pipeline: { ...fakePipeline(project, () => ({ accepted: true })).pipeline, findProject: async () => project }, projectNames: async () => new Map(), isSandboxName: () => false, log: () => undefined });
    await bench.run({ version: "v1", arm: "A", wait: true, pollMs: 1, minFreeGb: 0 } as never);
    await bench.run({ version: "v1", arm: "B", wait: true, pollMs: 1, minFreeGb: 0 } as never);
    expect(bench.compare({ version: "v1", armA: "A", armB: "B" }).comparison.verdict).toBe("pass");
    w.db.prepare("UPDATE lane_pilot_bench_run SET state='running' WHERE arm='B'").run();
    const midway = bench.compare({ version: "v1", armA: "A", armB: "B", harnessId: "harness_1" });
    expect(midway.comparison.verdict).toBe("inconclusive");
    expect(midway.text).toMatch(/B: repeat 1 is running/);
    expect(midway.verdictId).toBeNull();                        // no verdict is recorded: a harness tree is neither adopted nor retired on it
  });
});

describe("bench service", () => {
  it("records a verdict for a harness tree, and the status lists the series", async () => {
    const w = await builtSet();
    const project: BenchProjectRef = { projectId: "proj_bench", name: "LP bench s", hostId: "local", path: w.projectPath };
    const kv = new Map<string, unknown>();
    const bench = createBench({ db: w.db as never, kv: { get: async (k) => kv.get(k), set: async (k, v) => { kv.set(k, v); } }, host: localHost,
      pipeline: { ...fakePipeline(project, () => ({ accepted: true })).pipeline, findProject: async () => project }, projectNames: async () => new Map(), isSandboxName: () => false, log: () => undefined });
    await bench.run({ version: "v1", arm: "A", wait: true, pollMs: 1, minFreeGb: 0 } as never);
    await bench.run({ version: "v1", arm: "B", wait: true, pollMs: 1, minFreeGb: 0 } as never);
    const result = bench.compare({ version: "v1", armA: "A", armB: "B", harnessId: "harness_1" });
    expect(result.comparison.verdict).toBe("pass");
    expect(result.verdictId).toMatch(/^benchverdict_/);
    expect(bench.status("v1")[0]!.runs.map((r) => [r.arm, r.state, r.accepted])).toEqual([["A", "done", 3], ["B", "done", 3]]);
    expect((await bench.configure({ budgetTokens: 5_000_000 })).budgetTokens).toBe(5_000_000);
    await expect(bench.configure({ budgetHours: -1 })).rejects.toThrow(/positive/);
  });
});

describe("bench runner: ids and the command line", () => {
  it("follows the task id the pipeline gives when it renames a task it has seen before", async () => {
    const w = await builtSet();
    const project: BenchProjectRef = { projectId: "proj_bench", name: "LP bench r", hostId: "local", path: w.projectPath };
    const asked: string[] = [];
    const base = fakePipeline(project, () => ({ accepted: true })).pipeline;
    const pipeline: PipelinePort = {
      ...base,
      dispatch: async (_p, _pm, task) => ({ ok: true, detail: "queued", taskId: `${String(task.id)}.2` }),
      outcome: async (_run, taskId) => { asked.push(taskId); return { latestState: taskId.endsWith(".2") ? "accepted" : null, attempts: 1 }; },
    };
    const report = await runSeries({ db: w.db as never, host: localHost, pipeline, clock: clock(), projectNameFor: () => project.name }, { minFreeGb: 0, version: "v1", arm: "renamed", only: ["task-a"], pollMs: 1 });
    expect(report).toMatchObject({ accepted: 1, ran: 1 });
    expect(asked.every((id) => id.endsWith(".2"))).toBe(true);
  });

  it("parses the bench command line: writer, repeatable settings, fault and caps", async () => {
    const { runBenchCli } = await import("../../src/rooms/bench/cli");
    const calls: unknown[] = [];
    const sets: Array<{ version: string; createdAt: number }> = [];
    const bench = { run: async (input: unknown) => { calls.push(input); return []; }, build: async (input: unknown) => { calls.push(input); return {}; }, status: () => sets } as never;
    const ok = await runBenchCli(bench, ["run", "--arm", "x", "--writer", "codex/gpt-6-luna", "--setting", "plan_critique.enabled=true", "--setting", "quality_mode=\"full\"", "--repeat", "2", "--tasks", "3", "--fault", "owns", "--budget-tokens", "1000"]);
    expect(ok.exitCode).toBe(0);
    expect(calls[0]).toMatchObject({ version: "v1", arm: "x", writer: { providerId: "codex", model: "gpt-6-luna" }, settings: { "plan_critique.enabled": true, quality_mode: "full" }, repeat: 2, limit: 3, fault: "owns", budgetTokens: 1000 });
    // Without --set: the newest set to run on, the next free version to build.
    sets.push({ version: "v1", createdAt: 1 }, { version: "v2", createdAt: 2 });
    await runBenchCli(bench, ["run", "--arm", "y"]);
    await runBenchCli(bench, ["build"]);
    expect(calls.slice(1)).toMatchObject([{ version: "v2", arm: "y" }, { version: "v3" }]);
    expect((await runBenchCli(bench, ["run"])).exitCode).toBe(1);
    expect((await runBenchCli(bench, ["run", "--arm", "x", "--writer", "nomodel"])).stderr).toMatch(/provider\/model/);
    expect((await runBenchCli(bench, ["run", "--arm", "x", "--fault", "cosmic"])).stderr).toMatch(/owns or read_first/);
    expect((await runBenchCli(bench, ["run", "--arm", "x", "--bogus", "1"])).stderr).toMatch(/unknown flag/);
  });
});
