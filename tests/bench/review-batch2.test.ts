import { describe, expect, it, vi } from "vitest";
import { createBench } from "../../src/rooms/bench/service";
import { buildSet } from "../../src/rooms/bench/build";
import { freshStratum } from "../../src/rooms/bench/stratify";
import type { Candidate } from "../../src/rooms/bench/types";
import { benchWorld, localHost, makeContract, makeRepo, tmp } from "./helpers";

const BB = "proj_ejbam66722";
const DAY = 86_400_000;

describe("review batch2: repos_root clearing and the fresh pool", () => {
  it("`bench config repos_root=` (empty) clears the root even when BENCH_REPOS_ROOT is set", async () => {
    vi.stubEnv("BENCH_REPOS_ROOT", "/env/repos");
    const store = new Map<string, unknown>();
    const bench = createBench({
      db: {} as never, host: {} as never, pipeline: {} as never, log: () => undefined,
      projectNames: async () => new Map(), isSandboxName: () => false,
      kv: { get: async (key: string) => store.get(key) ?? null, set: async (key: string, value: unknown) => { store.set(key, value); } } as never,
    });
    await bench.configure({ reposRoot: null });
    expect((await bench.placement()).reposRoot).toBeNull();
    vi.unstubAllEnvs();
  });

  it("a candidate a fixed stratum already tried is not warmed again in fresh", async () => {
    const now = 40 * DAY;
    const { repo, bases } = makeRepo([{ file: "a.txt", attemptId: "att_a", taskId: "task-a" }]);
    const w = benchWorld();
    // task-bad: recent, live, but its recorded base is not in the repo -> warmUp fails `base_unreachable`.
    w.accepted({ taskId: "task-bad", projectId: BB, contract: makeContract(repo), base: "f".repeat(40), attemptId: "att_bad" });
    w.accepted({ taskId: "task-bad2", projectId: BB, contract: makeContract(repo), base: "e".repeat(40), attemptId: "att_bad2" });
    w.db.prepare("UPDATE lane_pilot_attempt SET updated_at=?").run(now - DAY);
    const names = new Map([[BB, "BB-сервис"]]);
    const projects = [{ projectId: BB, name: "BB-сервис", cwdPrefixes: [repo] }];
    const strata = [
      { key: "bb-service", quota: 1, match: (c: Candidate) => c.projectId === BB },
      freshStratum(now),
    ];
    const { rejected } = await buildSet({
      db: w.db as never, host: localHost, version: "v-dup", strata, projects, hostFor: () => "local", now,
      scratch: tmp("lp-bench-scratch-"), minFreeGb: 0, projectNames: names, isSandboxName: () => false, triesFactor: 4,
    });
    const bad = rejected.filter((row) => row.taskId.startsWith("task-bad"));
    expect(bad.map((row) => row.stratum)).toEqual(["bb-service", "bb-service"]);
  });
});
