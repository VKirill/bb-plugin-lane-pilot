import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/storage/database";
import { latestNoise, saveNoise, saveVerdict, listRuns } from "../../src/rooms/bench/store";
import { createBench } from "../../src/rooms/bench/service";
import { runSeries } from "../../src/rooms/bench/runner";
import { buildSet } from "../../src/rooms/bench/build";
import { isSandboxProjectName } from "../../src/rooms/stability/server";
import { benchWorld, localHost, makeContract, makeRepo, tmp } from "./helpers";
import type { BenchProjectRef, Clock, HostPort, PipelinePort } from "../../src/rooms/bench/ports";

const BB = "proj_ejbam66722";

describe("bench verdict dedupe", () => {
  it("returns the existing row for the same verdict inside an hour", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    db.prepare("INSERT INTO lane_pilot_bench_set(id,version,manifest_sha256,task_count,candidate_count,created_at) VALUES('s1','v0','x',0,0,0)").run();
    const one = saveVerdict(db, { setId: "s1", armA: "a", armB: "b", harnessId: "h", passed: true, report: { v: 1 }, now: 1000 });
    const two = saveVerdict(db, { setId: "s1", armA: "a", armB: "b", harnessId: "h", passed: true, report: { v: 1 }, now: 2000 });
    expect(two.id).toBe(one.id);
    const three = saveVerdict(db, { setId: "s1", armA: "a", armB: "b", harnessId: "h", passed: false, report: {}, now: 3000 });
    expect(three.id).not.toBe(one.id);
    const later = saveVerdict(db, { setId: "s1", armA: "a", armB: "b", harnessId: "h", passed: true, report: { v: 1 }, now: 1000 + 3_700_000 });
    expect(later.id).not.toBe(one.id);
  });
});

describe("nightly noise rows", () => {
  const clock = (): Clock => { let t = 1_000_000; return { now: () => t, sleep: async (ms) => { t += ms; } }; };
  it("a two-repeat series writes a lane_pilot_bench_noise row without the noise flag", async () => {
    const { repo, bases } = makeRepo([{ file: "a.txt", attemptId: "att_a", taskId: "task-a" }]);
    const w = benchWorld();
    w.accepted({ taskId: "task-a", projectId: BB, base: bases[0]!, attemptId: "att_a",
      contract: makeContract(repo, { read_first: [], expected_outputs: ["a.txt"], owns_paths: ["a.txt"], verification: [{ command: "test -f a.txt", cwd: repo }, { command: "grep -q done a.txt", cwd: repo }] }) });
    await buildSet({ db: w.db as never, host: localHost, version: "v1", strata: [{ key: "bb-service", quota: 1, match: (c) => c.projectId === BB }],
      projects: [{ projectId: BB, name: "BB-сервис", cwdPrefixes: [repo] }], hostFor: () => "local", scratch: tmp("lp-bench-scratch-"), minFreeGb: 0,
      projectNames: new Map([[BB, "BB-сервис"]]), isSandboxName: isSandboxProjectName });
    const project: BenchProjectRef = { projectId: "proj_bench", name: "LP bench x", hostId: "local", path: tmp("lp-bench-project-") };
    const pipeline: PipelinePort = {
      findProject: async () => project, configure: async () => undefined,
      startRun: async () => ({ pmThreadId: "pm", runId: "lprun" }),
      dispatch: async () => ({ ok: true, detail: "queued" }),
      outcome: async () => ({ latestState: "accepted", attempts: 1 }),
      metrics: async () => [], cancel: async () => undefined, finishRun: async () => undefined,
    };
    const bench = createBench({ db: w.db as never, kv: w.bb.storage.kv as never, host: localHost, pipeline, projectNames: async () => new Map(), isSandboxName: isSandboxProjectName, log: () => undefined });
    const reports = await bench.run({ version: "v1", arm: "night-x", repeat: 2, wait: true, pollMs: 1, minFreeGb: 0 } as never);
    const rows = (Array.isArray(reports) ? reports : [reports]) as Array<{ state?: string }>;
    expect(rows.every((r) => r.state === "done")).toBe(true);
    expect(latestNoise(w.db as never, "benchset_v1")).not.toBeNull();
  });
});
