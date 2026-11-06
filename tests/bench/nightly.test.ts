import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import plugin from "../../server";
import { nightArm } from "../../src/rooms/bench/runner";
import { isSkippedByBudget, markSkippedRun, insertSet } from "../../src/rooms/bench/store";
import { nightlySets } from "../../src/rooms/bench/server/weekly";
import { benchWorld } from "./helpers";
import type { ManifestTask } from "../../src/rooms/bench/types";
import { OVH_BENCH_HOST, mountBenchNightly, nightlyRepeats, nightlyRun } from "../../src/rooms/bench/server/weekly";

describe("bench nightly on OVH", () => {
  it("runs the whole set on the OVH host under a night arm", async () => {
    const input = nightlyRun("v3", "0.1.389");
    expect(OVH_BENCH_HOST).toBe("host_rwrxyi39aw");
    expect(input).toEqual({ version: "v3", arm: nightArm("0.1.389"), wait: true, hostId: OVH_BENCH_HOST, noise: true });
    expect(input.arm.startsWith("night-")).toBe(true);
    expect(input).not.toHaveProperty("limit");
    expect(nightlyRepeats(0)).toBe(3);
    expect(nightlyRepeats(1)).toBe(3);
    expect(nightlyRepeats(3)).toBe(3);
    const scheduled: Array<{ name: string; cron: string; work: (signal?: AbortSignal) => Promise<void> | void }> = [];
    const runs: unknown[] = [];
    const bb = { background: { schedule: (name: string, cron: string, work: (signal?: AbortSignal) => Promise<void> | void) => scheduled.push({ name, cron, work }) } };
    const bench = () => ({
      status: () => [{ version: "v3", createdAt: 1 }],
      placement: async () => ({ noiseRepeats: 3 }),
      settings: async () => ({ budgetTokens: 100 }),
      run: async (input: unknown) => { runs.push(input); return []; },
      armStrata: async () => [],
      markSkipped: () => undefined,
    });
    const ctx = { bb, db: { prepare: () => ({ all: () => [], get: () => undefined }) }, isDisposed: () => false, log: () => undefined };
    mountBenchNightly(ctx as never, bench as never);
    expect(scheduled).toEqual([{ name: "bench-nightly", cron: "30 1 * * *", work: expect.any(Function) }]);
    await scheduled[0]!.work();
    expect(runs[0]).toMatchObject({ version: "v3", arm: nightArm(packageJson.version), wait: true, hostId: OVH_BENCH_HOST, noise: true });
  });

  it("is registered by the plugin itself at 01:30 UTC", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    expect(harness.registrations.schedules).toContainEqual({ name: "bench-nightly", cron: "30 1 * * *", fn: expect.any(Function) });
    await harness.lifecycle.dispose();
  });
});

describe("the night runs every active set", () => {
  it("nightlySets: all sets by default, or the versions bench.nightly_sets names", () => {
    const status = [{ version: "v5" }, { version: "v4" }, { version: "v3" }];
    expect(nightlySets(status, undefined)).toEqual(["v5", "v4", "v3"]);
    expect(nightlySets(status, "all")).toEqual(["v5", "v4", "v3"]);
    expect(nightlySets(status, "v3,v5")).toEqual(["v5", "v3"]);
    expect(nightlySets(status, "v9")).toEqual([]);
    expect(nightlySets(status, "")).toEqual(["v5", "v4", "v3"]);
  });

  it("nightlySets: the sealed pool never runs in the night arm", () => {
    const status = [{ version: "v5" }, { version: "sealed-week-2026-44" }, { version: "v4" }];
    expect(nightlySets(status, undefined)).toEqual(["v5", "v4"]);
    expect(nightlySets(status, "sealed-week-2026-44")).toEqual([]);
  });

  it("a budget-skipped set gets a marked run row, and armStrata renders one line per stratum", () => {
    const { db } = benchWorld();
    const set = insertSet(db, { version: "v4", tasks: [task("t1"), task("t2", "noncode")], rejected: [], candidateCount: 2, config: {} });
    const marked = markSkippedRun(db, { setId: set.id, arm: "night-x", repeat: 1, reason: "skipped: budget" });
    expect(marked.state).toBe("stopped_budget");
    expect(isSkippedByBudget(marked)).toBe(true);
    // Idempotent: the same arm is not marked twice.
    expect(markSkippedRun(db, { setId: set.id, arm: "night-x", repeat: 1, reason: "skipped: again" }).id).toBe(marked.id);
  });
});
const task = (taskId: string, stratum = "small"): ManifestTask => ({
  taskId, position: 0, projectId: "P", projectName: "P", hostId: "h", repoPath: "/repo", stratum, hard: false, risk: "low", area: "a",
  initialHeadSha: "a".repeat(40), solutionCommit: "b".repeat(40), solutionPatchSha256: "c".repeat(64), contract: {},
  warm: { base: [], solution: [], discriminating: [], applied: "apply", files: [] },
});
