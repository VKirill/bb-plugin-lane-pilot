import { describe, expect, it } from "vitest";
import { buildSet } from "../../src/rooms/bench/build";
import { compareArms, noiseOfRepeats, passReport, summarizeArm } from "../../src/rooms/bench/compare";
import { runBenchCli } from "../../src/rooms/bench/cli";
import type { BenchProjectRef, Clock, ExecResult, HostPort, PipelinePort } from "../../src/rooms/bench/ports";
import { benchArmStatus, sweepStuckRuns } from "../../src/rooms/bench/reliability";
import { DEFAULT_BUDGET_HOURS, DEFAULT_BUDGET_TOKENS, nightArm, runSeries } from "../../src/rooms/bench/runner";
import { createBench } from "../../src/rooms/bench/service";
import { getRun, getSet, latestNoise, listResults, startRunRow, verifySet } from "../../src/rooms/bench/store";
import type { BenchResult } from "../../src/rooms/bench/store";
import { isSandboxProjectName } from "../../src/rooms/stability/server";
import type { AttemptMetrics } from "../../src/rooms/usage/server/attempt-metrics";
import type { BenchProject, Candidate } from "../../src/rooms/bench/types";
import { benchWorld, localHost, makeContract, makeRepo, tmp } from "./helpers";

const BB = "proj_ejbam66722";

async function builtSet() {
  const { repo, bases } = makeRepo([{ file: "a.txt", attemptId: "att_a", taskId: "task-a" }]);
  const w = benchWorld();
  w.accepted({ taskId: "task-a", projectId: BB, base: bases[0]!, attemptId: "att_a",
    contract: makeContract(repo, { expected_outputs: ["a.txt"], owns_paths: ["a.txt"], verification: [{ command: "test -f a.txt", cwd: repo }, { command: "grep -q done a.txt", cwd: repo }] }) });
  const projects: BenchProject[] = [{ projectId: BB, name: "BB-сервис", cwdPrefixes: [repo] }];
  const strata = [{ key: "bb-service", quota: 1, match: (c: Candidate) => c.projectId === BB }];
  await buildSet({ db: w.db as never, host: localHost, version: "v1", strata, projects, hostFor: () => "local", scratch: tmp("lp-bench-scratch-"), minFreeGb: 0,
    projectNames: new Map([[BB, "BB-сервис"]]), isSandboxName: isSandboxProjectName });
  return { ...w, projectPath: tmp("lp-bench-project-") };
}

const attempt = (taskId: string): AttemptMetrics => ({
  taskId, attemptId: `${taskId}-1`, attemptNo: 1, state: "accepted", createdAt: 1, seconds: 10, stages: [], stagesPassed: 1, stagesFailed: 0, gates: { passed: 1, rejected: 0 },
  writer: { threadId: "thr", providerId: "codex", model: "gpt-6-luna" }, tokens: { input: 1, output: 1, cached: 0, total: 2 }, costUsd: 0.01, costState: "measured", costNote: null,
});

const clock = (): Clock => { let t = 1_000_000; return { now: () => t, sleep: async (ms) => { t += ms; } }; };

function hostReporting(freeGb: number): { host: HostPort; hosts: string[] } {
  const hosts: string[] = [];
  const host: HostPort = {
    run: (id, cwd, command, timeout) => {
      hosts.push(id);
      if (command.includes("df -Pk")) return Promise.resolve({ exitCode: 0, stdout: `${freeGb}\n`, stderr: "" } satisfies ExecResult);
      return localHost.run(id, cwd, command, timeout);
    },
  };
  return { host, hosts };
}

function pipelineFor(project: BenchProjectRef, start: PipelinePort["startRun"]) {
  const configure: unknown[] = [];
  const pipeline: PipelinePort = {
    findProject: async (name) => (name === project.name ? project : null),
    configure: async (_project, input) => { configure.push(input); },
    startRun: start,
    dispatch: async () => ({ ok: true, detail: "queued" }),
    outcome: async () => ({ latestState: "accepted", attempts: 1 }),
    metrics: async (_p, _run, taskId) => [attempt(taskId)],
    cancel: async () => undefined,
    finishRun: async () => undefined,
  };
  return { pipeline, configure };
}

const row = (taskId: string, accepted: boolean, repeatState: BenchResult["state"] = accepted ? "accepted" : "not_accepted"): BenchResult => ({
  runId: "r", taskId, position: 1, state: repeatState, accepted, benchTaskId: null, lpRunId: null, attempts: 1, stagesPassed: 1, stagesFailed: 0,
  tokens: 1, costUsd: 0.01, costState: "measured", seconds: 1, reason: null, recordedAt: 1,
});

describe("S1 bench reliability", () => {
  it("S1 disk: a host below the free-space floor defers the series instead of recording stopped_budget", async () => {
    const w = await builtSet();
    const project: BenchProjectRef = { projectId: "proj_bench", name: "LP bench disk", hostId: "local", path: w.projectPath };
    const { host } = hostReporting(10);
    const { pipeline } = pipelineFor(project, async () => ({ pmThreadId: "pm", runId: "lprun" }));
    const report = await runSeries({ db: w.db as never, host, pipeline, clock: clock(), projectNameFor: () => project.name }, { version: "v1", arm: "night-disk", pollMs: 1 });
    expect(report.state).toBe("deferred");
    expect(report.stopReason).toMatch(/^deferred: host local has 10 GB free, below 25/);
    expect(getRun(w.db as never, getSet(w.db as never, "v1")!.id, "night-disk", 1)).toBeNull();
  });

  it("S1 stuck: a run still running past its hour cap is closed failed with a stuck reason", () => {
    const w = benchWorld();
    w.db.prepare("INSERT INTO lane_pilot_bench_set(id,version,manifest_sha256,task_count,candidate_count,rejected_json,config_json,created_at) VALUES('benchset_s1','s1','abc',0,0,'[]','{}',1)").run();
    const old = Date.now() - 7 * 3_600_000;
    const stuck = startRunRow(w.db as never, { setId: "benchset_s1", arm: "night-0.1.352", repeat: 1, config: {}, budgetTokens: 1, budgetHours: 6, now: old });
    const young = startRunRow(w.db as never, { setId: "benchset_s1", arm: "night-young", repeat: 1, config: {}, budgetTokens: 1, budgetHours: 6, now: Date.now() - 3_600_000 });
    const closed = sweepStuckRuns(w.db as never, Date.now());
    expect(closed.map((row) => row.id)).toEqual([stuck.id]);
    expect(closed[0]!.stopReason).toMatch(/stuck: running past its 6 h cap since/);
    expect(getRun(w.db as never, "benchset_s1", "night-0.1.352", 1)).toMatchObject({ state: "failed" });
    expect(getRun(w.db as never, "benchset_s1", "night-young", 1)!.state).toBe("running");
    expect(young.id).not.toBe(stuck.id);
  });

  it("S1 provider: an unsupported provider is unavailable and is not retried", async () => {
    const w = await builtSet();
    const project: BenchProjectRef = { projectId: "proj_bench", name: "LP bench provider", hostId: "local", path: w.projectPath };
    const { host } = hostReporting(100);
    let starts = 0;
    const { pipeline, configure } = pipelineFor(project, async () => {
      starts++;
      throw new Error("HTTP 400: vk_compiled_main_agent_unsupported_provider");
    });
    const writer = { providerId: "codex", model: "gpt-6-luna" };
    const report = await runSeries({ db: w.db as never, host, pipeline, clock: clock(), projectNameFor: () => project.name }, { version: "v1", arm: "night-provider", writer, pollMs: 1 });
    expect(report.state).toBe("unavailable");
    expect(report.stopReason).toMatch(/unavailable: HTTP 400: vk_compiled_main_agent_unsupported_provider/);
    expect(report.stopReason).toMatch(/stayed on codex\/gpt-6-luna/);
    expect(starts).toBe(1);
    expect(configure).toHaveLength(1);
    expect(configure[0]).toMatchObject({ settings: { "writer.provider": "codex", "writer.model": "gpt-6-luna" } });
    const saved = getRun(w.db as never, getSet(w.db as never, "v1")!.id, "night-provider", 1)!;
    expect(saved.state).toBe("failed");
    expect(saved.config.writer).toEqual(writer);
  });

  it("S1 provider: a non-provider error is not retried", async () => {
    const w = await builtSet();
    const project: BenchProjectRef = { projectId: "proj_bench", name: "LP bench other", hostId: "local", path: w.projectPath };
    const { host } = hostReporting(100);
    let starts = 0;
    const { pipeline, configure } = pipelineFor(project, async () => { starts++; throw new Error("the bench source thread did not start"); });
    const report = await runSeries({ db: w.db as never, host, pipeline, clock: clock(), projectNameFor: () => project.name }, { version: "v1", arm: "night-other", pollMs: 1 });
    expect(report.state).toBe("failed");
    expect(starts).toBe(1);
    expect(configure[0]).toMatchObject({ settings: { "writer.provider": "claude-code", "writer.model": "claude-haiku-5-5" } });
    expect(getRun(w.db as never, getSet(w.db as never, "v1")!.id, "night-other", 1)!.config.writer).toEqual({ providerId: "claude-code", model: "claude-haiku-5-5" });
  });

  it("S1 writer: a night arm names the model, and compareArms refuses a different writer", () => {
    expect(nightArm("0.1.400")).toBe("night-0.1.400-claude-haiku-5-5");
    expect(nightArm("0.1.400", { model: "gpt-6-luna" })).toBe("night-0.1.400-gpt-6-luna");
    const tasks = ["t1", "t2", "t3", "t4"].map((id) => row(id, true));
    const luna = summarizeArm("night-0.1.328-gpt-6-luna", [tasks]);
    const haiku = summarizeArm("night-0.1.400-claude-haiku-5-5", [tasks]);
    luna.writer = { providerId: "codex", model: "gpt-6-luna" };
    haiku.writer = { providerId: "claude-code", model: "claude-haiku-5-5" };
    const mixed = compareArms(luna, haiku);
    expect(mixed.verdict).toBe("inconclusive");
    expect(mixed.checks.find((check) => check.name === "writer")?.detail).toMatch(/codex\/gpt-6-luna.*claude-code\/claude-haiku-5-5/);
    haiku.writer = { providerId: "codex", model: "gpt-6-luna" };
    const same = compareArms(luna, haiku);
    expect(same.verdict).toBe("pass");
    expect(same.checks.some((check) => check.name === "writer")).toBe(false);
  });

  it("S1 host: bench.host is the machine the series runs on", async () => {
    const w = await builtSet();
    const project: BenchProjectRef = { projectId: "proj_bench", name: "LP bench host", hostId: "local", path: w.projectPath };
    const { host, hosts } = hostReporting(100);
    let seen = "";
    const { pipeline } = pipelineFor(project, async (placed) => { seen = placed.hostId; return { pmThreadId: "pm", runId: "lprun" }; });
    const report = await runSeries({ db: w.db as never, host, pipeline, clock: clock(), projectNameFor: () => project.name }, { version: "v1", arm: "on-ovh", hostId: "host_ovh", pollMs: 1 });
    expect(report.state).toBe("done");
    expect(hosts.every((id) => id === "host_ovh")).toBe(true);
    expect(seen).toBe("host_ovh");
    const kv = new Map<string, unknown>();
    const bench = createBench({ db: w.db as never, kv: { get: async (key) => kv.get(key), set: async (key, value) => { kv.set(key, value); } }, host, pipeline,
      projectNames: async () => new Map(), isSandboxName: () => false, log: () => undefined });
    expect((await bench.placement()).hostId).toBeNull();
    await bench.configure({ hostId: "host_ovh", noiseRepeats: 3 });
    expect(await bench.placement()).toMatchObject({ hostId: "host_ovh", noiseRepeats: 3 });
    expect(await bench.settings()).toEqual({ budgetTokens: DEFAULT_BUDGET_TOKENS, budgetHours: DEFAULT_BUDGET_HOURS });
  });

  it("S1 noise: the same set N times records pass@1 and pass^k and does not change the frozen set", async () => {
    const flipped = passReport([[row("t", true)], [row("t", false)]]);
    expect(flipped).toMatchObject({ tasks: 1, repeats: 2, passAt1: 1, passPow: 0 });
    expect(noiseOfRepeats("arm", [[row("t", true)], [row("t", false)]])!.flipShare).toBe(1);

    const w = await builtSet();
    const before = getSet(w.db as never, "v1")!;
    const project: BenchProjectRef = { projectId: "proj_bench", name: "LP bench noise", hostId: "local", path: w.projectPath };
    const { host } = hostReporting(100);
    const { pipeline } = pipelineFor(project, async () => ({ pmThreadId: "pm", runId: "lprun" }));
    const kv = new Map<string, unknown>();
    const bench = createBench({ db: w.db as never, kv: { get: async (key) => kv.get(key), set: async (key, value) => { kv.set(key, value); } }, host, pipeline,
      projectNames: async () => new Map(), isSandboxName: () => false, log: () => undefined, projectNameFor: () => project.name });
    const reports = await bench.run({ version: "v1", arm: "noise", wait: true, noise: true, repeat: 2, pollMs: 1, minFreeGb: 0 });
    expect(Array.isArray(reports) && reports.every((row) => row.state === "done" && row.passAt1 === 1 && row.passPow === 1)).toBe(true);
    const noise = latestNoise(w.db as never, before.id);
    expect(noise).toMatchObject({ armA: "noise#1", armB: "noise#2" });
    const after = getSet(w.db as never, "v1")!;
    expect(after.manifestSha256).toBe(before.manifestSha256);
    expect(after.tasks).toHaveLength(before.tasks.length);
    expect(verifySet(after)).toEqual({ ok: true });
    expect(() => w.db.prepare("UPDATE lane_pilot_bench_task SET area='changed' WHERE set_id=?").run(before.id)).toThrow(/never changed/);
    expect(listResults(w.db as never, getRun(w.db as never, before.id, "noise", 1)!.id)).toHaveLength(1);
  });

  it("S1 arm: a disk stop is deferred, a finished budget stop is done", () => {
    expect(benchArmStatus([])).toBe("absent");
    expect(benchArmStatus([{ state: "running", stopReason: null }])).toBe("running");
    expect(benchArmStatus([{ state: "stopped_budget", stopReason: "host host_7sea4qaad8 has 13 GB free, below 25" }])).toBe("deferred");
    expect(benchArmStatus([{ state: "stopped_budget", stopReason: "deferred: host x has 10 GB free, below 25" }])).toBe("deferred");
    expect(benchArmStatus([{ state: "stopped_budget", stopReason: "token budget: 1 used of 2" }])).toBe("done");
    expect(benchArmStatus([{ state: "done", stopReason: null }])).toBe("done");
    expect(benchArmStatus([{ state: "failed", stopReason: "HTTP 400: vk_compiled_main_agent_unsupported_provider" }])).toBe("unavailable");
  });

  it("S1 cli: host, noise and sweep are options", async () => {
    const seen: unknown[] = [];
    const bench = {
      run: async (input: unknown) => { seen.push(input); return []; },
      configure: async (input: unknown) => { seen.push(input); return { budgetTokens: 1, budgetHours: 1 }; },
      settings: async () => ({ budgetTokens: DEFAULT_BUDGET_TOKENS, budgetHours: DEFAULT_BUDGET_HOURS }),
      placement: async () => ({ hostId: "host_ovh", noiseRepeats: 3 }),
      status: () => [{ version: "v1", createdAt: 1, runs: [] }],
      sweep: () => [{ id: "benchrun_0fe9e412b8af", arm: "night-0.1.352", stopReason: "stuck: running past its 6 h cap since 2026-10-28T03:01:10.000Z" }],
    } as never;
    expect((await runBenchCli(bench, ["run", "--arm", "week", "--noise", "3"])).exitCode).toBe(0);
    expect(seen[0]).toMatchObject({ arm: "week", repeat: 3, noise: true });
    expect((await runBenchCli(bench, ["config", "host=host_ovh", "noise_repeats=3"])).exitCode).toBe(0);
    expect(seen[1]).toMatchObject({ hostId: "host_ovh", noiseRepeats: 3 });
    const swept = await runBenchCli(bench, ["sweep"]);
    expect(swept.exitCode).toBe(0);
    expect(swept.stdout).toMatch(/benchrun_0fe9e412b8af/);
    expect((await runBenchCli(bench, ["run", "--arm", "week", "--noise", "1"])).stderr).toMatch(/2 to 10/);
    expect((await runBenchCli(bench, ["config", "writers=claude-code/claude-haiku-5-5"])).stderr).toMatch(/noise_repeats/);
  });
});
