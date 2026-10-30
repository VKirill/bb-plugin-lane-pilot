import { describe, expect, it } from "vitest";
import { buildSet } from "../../src/rooms/bench/build";
import { loadCandidates } from "../../src/rooms/bench/candidates";
import { cohortCounts, freshStratum } from "../../src/rooms/bench/stratify";
import type { BenchProject, Candidate } from "../../src/rooms/bench/types";
import { benchWorld, localHost, makeContract, makeRepo, tmp } from "./helpers";

const BB = "proj_ejbam66722";
const DAY = 86_400_000;

describe("fresh bench stratum", () => {
  it("takes only recently accepted tasks, and a run reports fixed and fresh apart", () => {
    const now = 40 * DAY;
    const recent: Candidate = { taskId: "new", runId: "r", projectId: BB, projectName: "BB", attemptId: "a", attemptNo: 1, hard: false, risk: "low", area: "", repoPath: "/r", hostId: "h", initialHeadSha: "a".repeat(40), baseSha: null, contract: {}, acceptedAt: now - DAY };
    const old: Candidate = { ...recent, taskId: "old", acceptedAt: now - 30 * DAY };
    const stratum = freshStratum(now);
    expect(stratum.match(recent)).toBe(true);
    expect(stratum.match(old)).toBe(false);
    expect(stratum.match({ ...recent, acceptedAt: undefined })).toBe(false);
    expect(cohortCounts(
      [{ taskId: "a", stratum: "bb-service" }, { taskId: "b", stratum: "fresh" }],
      [{ taskId: "a", accepted: true, state: "accepted" }, { taskId: "b", accepted: false, state: "not_accepted" }, { taskId: "b", accepted: true, state: "skipped_budget" }],
    )).toEqual({ fixed: { tasks: 1, accepted: 1 }, fresh: { tasks: 1, accepted: 0 } });
  });

  it("keeps the fixed quota and adds the recent tasks it did not keep, leaving sandbox and old tasks out", async () => {
    const now = 40 * DAY;
    const { repo, bases } = makeRepo([
      { file: "a.txt", attemptId: "att_a", taskId: "task-a" },
      { file: "b.txt", attemptId: "att_b", taskId: "task-b" },
      { file: "c.txt", attemptId: "att_c", taskId: "task-old" },
    ]);
    const w = benchWorld();
    const contract = (file: string) => makeContract(repo, {
      expected_outputs: [file], owns_paths: [file],
      verification: [{ command: `test -f ${file}`, cwd: repo }, { command: `grep -q done ${file}`, cwd: repo }],
    });
    w.accepted({ taskId: "task-a", projectId: BB, contract: contract("a.txt"), base: bases[0]!, attemptId: "att_a" });
    w.accepted({ taskId: "task-b", projectId: BB, contract: contract("b.txt"), base: bases[1]!, attemptId: "att_b" });
    w.accepted({ taskId: "task-old", projectId: BB, contract: contract("c.txt"), base: bases[2]!, attemptId: "att_c" });
    w.accepted({ taskId: "task-sand", projectId: "proj_sand", contract: contract("a.txt"), base: bases[0]!, attemptId: "att_s" });
    w.db.prepare("UPDATE lane_pilot_attempt SET updated_at=? WHERE task_id IN ('task-a','task-b')").run(now - DAY);
    w.db.prepare("UPDATE lane_pilot_attempt SET updated_at=? WHERE task_id='task-old'").run(1);
    const projects: BenchProject[] = [
      { projectId: BB, name: "BB-сервис", cwdPrefixes: [repo] },
      { projectId: "proj_sand", name: "LP bench toy", cwdPrefixes: [repo] },
    ];
    const names = new Map([[BB, "BB-сервис"], ["proj_sand", "LP bench toy"]]);
    const loaded = loadCandidates(w.db as never, { projectNames: names, isSandboxName: (name) => name.startsWith("LP "), projects, hostFor: () => "local" });
    expect(loaded.candidates.map((row) => row.taskId).sort()).toEqual(["task-a", "task-b", "task-old"]);
    expect(loaded.counts.sandbox_project).toBe(1);
    const strata = [
      { key: "bb-service", quota: 1, match: (c: Candidate) => c.projectId === BB },
      freshStratum(now),
    ];
    const { tasks } = await buildSet({
      db: w.db as never, host: localHost, version: "v-fresh", strata, projects, hostFor: () => "local", now,
      scratch: tmp("lp-bench-scratch-"), minFreeGb: 0, projectNames: names, isSandboxName: (name) => name.startsWith("LP "),
    });
    const fixed = tasks.filter((task) => task.stratum !== "fresh").map((task) => task.taskId);
    const fresh = tasks.filter((task) => task.stratum === "fresh").map((task) => task.taskId);
    expect(fixed).toHaveLength(1);
    expect(fresh.sort()).toEqual(["task-a", "task-b"].filter((id) => !fixed.includes(id)));
    expect(fresh).not.toContain("task-old");
    expect(tasks.map((task) => task.taskId)).not.toContain("task-sand");
  });
});
