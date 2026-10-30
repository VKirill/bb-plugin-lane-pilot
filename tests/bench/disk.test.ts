import { describe, expect, it } from "vitest";
import { buildSet } from "../../src/rooms/bench/build";
import type { BenchProjectRef, Clock, HostPort, PipelinePort } from "../../src/rooms/bench/ports";
import { runSeries } from "../../src/rooms/bench/runner";
import { isSandboxProjectName } from "../../src/rooms/stability/server";
import type { AttemptMetrics } from "../../src/rooms/usage/server";
import { benchWorld, localHost, makeContract, makeRepo, tmp } from "./helpers";

const BB = "proj_ejbam66722";

async function builtSet() {
  const { repo, bases } = makeRepo([{ file: "a.txt", attemptId: "att_a", taskId: "task-a" }, { file: "b.txt", attemptId: "att_b", taskId: "task-b" }, { file: "c.txt", attemptId: "att_c", taskId: "task-c" }]);
  const w = benchWorld();
  ["a", "b", "c"].forEach((n, i) => w.accepted({ taskId: `task-${n}`, projectId: BB, base: bases[i]!, attemptId: `att_${n}`, attemptNo: 1,
    contract: makeContract(repo, { read_first: [], expected_outputs: [`${n}.txt`], owns_paths: [`${n}.txt`], verification: [{ command: `test -f ${n}.txt`, cwd: repo }, { command: `grep -q done ${n}.txt`, cwd: repo }] }) }));
  const built = await buildSet({ db: w.db as never, host: localHost, version: "v1", strata: [{ key: "bb-service", quota: 3, match: (c) => c.projectId === BB }],
    projects: [{ projectId: BB, name: "BB-сервис", cwdPrefixes: [repo] }], hostFor: () => "local", scratch: tmp("lp-bench-scratch-"), minFreeGb: 0,
    projectNames: new Map([[BB, "BB-сервис"]]), isSandboxName: isSandboxProjectName });
  return { w, repo, built, projectPath: tmp("lp-bench-project-") };
}

/** A host that answers `df` from a script and records cleanup commands; every other command exits 0. */
function diskHost(freeScript: number[]) {
  const calls: string[] = [];
  let i = 0;
  const host: HostPort = {
    run: async (_hostId, _cwd, command) => {
      calls.push(command);
      if (command.includes("df -Pk")) {
        const gb = freeScript[Math.min(i++, freeScript.length - 1)]!;
        return { exitCode: 0, stdout: `${gb}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { host, calls };
}

const clock = (): Clock => { let t = 1_000_000; return { now: () => t, sleep: async (ms) => { t += ms; } }; };

const attempt = (taskId: string): AttemptMetrics => ({
  taskId, attemptId: `${taskId}-1`, attemptNo: 1, state: "accepted", createdAt: 1, seconds: 10, stages: [], stagesPassed: 3, stagesFailed: 0, gates: { passed: 1, rejected: 0 },
  writer: { threadId: "thr", providerId: "p", model: "m", tier: null }, tokens: null, costUsd: null, costState: "not_measured", costNote: null,
});

function fakePipeline(project: BenchProjectRef) {
  const pipeline: PipelinePort = {
    findProject: async (name) => (name === project.name ? project : null),
    configure: async () => undefined,
    startRun: async () => ({ pmThreadId: "pm", runId: "lprun" }),
    dispatch: async () => ({ ok: true, detail: "queued" }),
    outcome: async () => ({ latestState: "accepted", attempts: 1 }),
    metrics: async (_p, _r, taskId) => [attempt(taskId)],
    cancel: async () => undefined, finishRun: async () => undefined,
  };
  return pipeline;
}

describe("bench disk floor", () => {
  const setup = async (freeScript: number[]) => {
    const { w, projectPath } = await builtSet();
    const project: BenchProjectRef = { projectId: "proj_bench", name: "LP bench x", hostId: "local", path: projectPath };
    const { host, calls } = diskHost(freeScript);
    return { w, project, host, calls };
  };
  const run = (s: Awaited<ReturnType<typeof setup>>, extra: Record<string, unknown> = {}) =>
    runSeries({ db: s.w.db as never, host: s.host, pipeline: fakePipeline(s.project), clock: clock(), projectNameFor: () => s.project.name },
      { version: "v1", arm: "arm", repeat: 1, pollMs: 1, ...extra });

  it("defers the start below 25 GB after cleaning the bench's own caches", async () => {
    const s = await setup([20, 20]);
    const report = await run(s);
    expect(report).toMatchObject({ state: "deferred", ran: 0 });
    expect(report.stopReason).toContain("below 25");
    expect(s.calls.some((c) => c.includes("$HOME/lp-bench"))).toBe(true);
  });

  it("keeps a running series going at 15 GB: the mid-run floor is 12", async () => {
    const s = await setup([30, 15, 15, 15]);
    const report = await run(s);
    expect(report).toMatchObject({ state: "done", ran: 3, accepted: 3 });
    expect(s.calls.some((c) => c.includes("$HOME/lp-bench"))).toBe(false);
  });

  it("stops below 12 GB after the cleanup pass could not free enough", async () => {
    const s = await setup([30, 10, 10]);
    const report = await run(s);
    expect(report.stopReason).toContain("below 12");
    expect(s.calls.some((c) => c.includes("rm -rf") || c.includes("$HOME/lp-bench"))).toBe(true);
  });

  it("continues when the cleanup pass brings the host back above the floor", async () => {
    const s = await setup([30, 10, 40, 40, 40]);
    const report = await run(s);
    expect(report).toMatchObject({ state: "done", ran: 3 });
  });
});
