import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSet } from "../../src/rooms/bench/build";
import { contractRejection } from "../../src/rooms/bench/candidates";
import { getSet, verifySet } from "../../src/rooms/bench/store";
import { chooseFinal, interleave, warmOrder } from "../../src/rooms/bench/stratify";
import { manifestHash, type BenchProject, type Candidate } from "../../src/rooms/bench/types";
import { findSolutionCommit, linkDependenciesCommand, warmUp } from "../../src/rooms/bench/warmup";
import { benchWorld, git, localHost, makeContract, makeRepo, tmp } from "./helpers";

const BB = "proj_ejbam66722";
const strata = [{ key: "bb-service", quota: 4, match: (c: Candidate) => c.projectId === BB }];

function scenario() {
  const { repo, base, bases } = makeRepo([
    { file: "a.txt", attemptId: "att_a", taskId: "task-a" },
    { file: "b.txt", attemptId: "att_b", taskId: "task-b" },
    { file: "c.txt", attemptId: "att_c", taskId: "task-c" },
    { file: "g.txt", attemptId: "att_g", taskId: "task-green" },
  ]);
  const w = benchWorld();
  const contract = (file: string, extra: Record<string, unknown> = {}) => makeContract(repo, {
    expected_outputs: [file], owns_paths: [file], verification: [{ command: `test -f ${file}`, cwd: repo }, { command: `grep -q done ${file}`, cwd: repo }], ...extra,
  });
  w.accepted({ taskId: "task-a", projectId: BB, contract: contract("a.txt"), base: bases[0]!, attemptId: "att_a" });
  w.accepted({ taskId: "task-b", projectId: BB, contract: contract("b.txt", { risk: "high" }), base: bases[1]!, attemptId: "att_b", attemptNo: 2 });
  w.accepted({ taskId: "task-c", projectId: BB, contract: contract("c.txt"), base: bases[2]!, attemptId: "att_c" });
  // Not candidates: a drill, a check that passes on the bare base, a task another task depends on.
  w.accepted({ taskId: "drill-1", projectId: BB, contract: contract("a.txt"), base: bases[0]!, attemptId: "att_d" });
  w.accepted({ taskId: "task-dep", projectId: BB, contract: contract("a.txt", { depends_on: ["task-a"] }), base: bases[0]!, attemptId: "att_e" });
  w.accepted({ taskId: "task-green", projectId: BB, contract: contract("g.txt", { verification: [{ command: "test -f README.md", cwd: repo }, { command: "grep -q base README.md", cwd: repo }] }), base: bases[3]!, attemptId: "att_g" });
  const projects: BenchProject[] = [{ projectId: BB, name: "BB-сервис", cwdPrefixes: [repo] }];
  return { ...w, repo, base, bases, projects };
}

const input = (s: ReturnType<typeof scenario>, extra: Record<string, unknown> = {}) => ({
  db: s.db as never, host: localHost, version: "v1", strata, projects: s.projects, hostFor: () => "local", scratch: tmp("lp-bench-scratch-"),
  projectNames: new Map([[BB, "BB-сервис"]]), isSandboxName: (name: string) => name.startsWith("LP "), minFreeGb: 0, ...extra,
});

describe("bench candidates", () => {
  it("refuses a contract with fewer than two checks, a dependency, secrets, the network or an empty check", () => {
    const ok = makeContract("/r");
    expect(contractRejection(ok)).toBeNull();
    expect(contractRejection({ ...ok, verification: [(ok.verification as unknown[])[0]] })).toBe("fewer_than_2_checks");
    expect(contractRejection({ ...ok, depends_on: ["x"] })).toBe("depends_on");
    expect(contractRejection({ ...ok, verification: [{ command: "npm test", cwd: "/r", secrets: ["KEY"] }, { command: "npm run lint", cwd: "/r" }] })).toBe("check_needs_secrets");
    expect(contractRejection({ ...ok, verification: [{ command: "curl https://x.test/health", cwd: "/r" }, { command: "npm run lint", cwd: "/r" }] })).toBe("check_needs_network_or_login");
    expect(contractRejection({ ...ok, verification: [{ command: "true", cwd: "/r" }, { command: "npm run lint", cwd: "/r" }] })).toBe("empty_check");
  });
});

describe("bench warm-up", () => {
  it("accepts a task whose solution passes on the base and whose checks fail on the bare base", async () => {
    const s = scenario();
    const candidate: Candidate = { taskId: "task-a", runId: "r", projectId: BB, projectName: "BB-сервис", attemptId: "att_a", attemptNo: 1, hard: false, risk: "medium", area: "", repoPath: s.repo, hostId: "local",
      initialHeadSha: s.bases[0]!, baseSha: s.bases[0]!, contract: makeContract(s.repo, { verification: [{ command: "test -f a.txt", cwd: s.repo }, { command: "grep -q done a.txt", cwd: s.repo }] }) };
    const result = await warmUp(localHost, candidate, { scratch: tmp("lp-bench-warm-") });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.base.map((row) => row.exitCode !== 0)).toEqual([true, true]);
    expect(result.record.solution.map((row) => row.exitCode)).toEqual([0, 0]);
    expect(result.record.discriminating).toHaveLength(2);
    expect(result.record.files).toContain("a.txt");
    expect(result.patchSha256).toMatch(/^[0-9a-f]{64}$/);
    // The merge commit is the solution, found by the attempt's trailer.
    expect(git(s.repo, "rev-parse", "--verify", `${result.solutionCommit}^2`)).toBeTruthy();
  });

  it("records why a candidate is left out", async () => {
    const s = scenario();
    const base: Candidate = { taskId: "task-a", runId: "r", projectId: BB, projectName: "x", attemptId: "att_a", attemptNo: 1, hard: false, risk: "low", area: "", repoPath: s.repo, hostId: "local",
      initialHeadSha: s.bases[0]!, baseSha: null, contract: makeContract(s.repo, { verification: [{ command: "test -f a.txt", cwd: s.repo }, { command: "grep -q done a.txt", cwd: s.repo }] }) };
    const options = { scratch: tmp("lp-bench-warm-") };
    expect(await warmUp(localHost, { ...base, initialHeadSha: "0".repeat(40) }, options)).toMatchObject({ ok: false, reason: "base_unreachable" });
    expect(await warmUp(localHost, { ...base, attemptId: "att_missing", taskId: "no-such-task" }, options)).toMatchObject({ ok: false, reason: "solution_commit_not_found" });
    const green = { ...base, contract: makeContract(s.repo, { verification: [{ command: "test -f README.md", cwd: s.repo }, { command: "grep -q base README.md", cwd: s.repo }] }) };
    expect(await warmUp(localHost, green, options)).toMatchObject({ ok: false, reason: "passes_on_base" });
    const broken = { ...base, contract: makeContract(s.repo, { verification: [{ command: "test -f a.txt", cwd: s.repo }, { command: "test -f never-there.txt", cwd: s.repo }] }) };
    expect(await warmUp(localHost, broken, options)).toMatchObject({ ok: false, reason: "solution_fails_checks" });
  });
});

describe("bench solution commit", () => {
  it("finds the «Merge writer work: <task id>: …» merge when sibling attempt branches carry the bare subject", async () => {
    const repo = tmp("lp-bench-selfy-");
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "base\n");
    git(repo, "add", "-A"); git(repo, "commit", "-qm", "base");
    for (const branch of ["a1", "a2", "a3"]) {
      git(repo, "checkout", "-q", "-b", branch, "main");
      writeFileSync(join(repo, `${branch}.txt`), "done\n");
      git(repo, "add", "-A"); git(repo, "commit", "-qm", "task-s: add a file");
    }
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--no-ff", "a2", "-m", "Merge writer work: task-s: add a file");
    const candidate: Candidate = { taskId: "task-s", runId: "r", projectId: BB, projectName: "BB-сервис", attemptId: "att_none", attemptNo: 1, hard: false, risk: "low", area: "", repoPath: repo, hostId: "local",
      initialHeadSha: git(repo, "rev-parse", "main~1"), baseSha: null, contract: makeContract(repo) };
    const found = await findSolutionCommit(localHost, candidate);
    expect(found).toEqual({ commit: git(repo, "rev-parse", "main") });
  });
});

describe("bench dependencies", () => {
  it("copies node_modules on Linux instead of symlinking it, so a monorepo's workspace links stay inside the clone", () => {
    const command = linkDependenciesCommand("/live/repo", "/clone");
    expect(command).toContain("cp -a '/live/repo'/");
    expect(command).not.toContain("ln -s");
    expect(command).toContain("-name dist");
  });
});

describe("bench build", () => {
  it("selects, warms up and freezes a set; the manifest hash is checked and the set is never changed", async () => {
    const s = scenario();
    const { report, tasks } = await buildSet(input(s));
    expect(report.candidates).toBe(4);
    expect(report.prefilter).toMatchObject({ depends_on: 1 });
    expect(tasks.map((t) => t.taskId).sort()).toEqual(["task-a", "task-b", "task-c"]);
    // task-green (a check that passes on the bare base) was a candidate and is recorded as rejected, with the reason.
    expect(report.tried).toBe(4);
    expect(report.survived).toBe(3);
    expect(report.strata[0]).toMatchObject({ tried: 4, survived: 3, kept: 3, rejected: { passes_on_base: 1 } });
    expect(report.hardShare).toBeCloseTo(1 / 3);
    expect(report.set?.manifestSha256).toBe(manifestHash(tasks));

    const stored = getSet(s.db as never, "v1")!;
    expect(stored.tasks).toHaveLength(3);
    expect(stored.rejected.find((row) => row.taskId === "task-green")).toMatchObject({ reason: "passes_on_base", stratum: "bb-service" });
    expect(verifySet(stored)).toEqual({ ok: true });
    expect(() => s.db.prepare("UPDATE lane_pilot_bench_task SET risk='low' WHERE set_id=?").run(stored.id)).toThrow(/never changed/);
    expect(() => s.db.prepare("DELETE FROM lane_pilot_bench_set").run()).toThrow(/never changed/);
    // A second build under the same version is refused; a hand-edited task would not hash to the stored value.
    await expect(buildSet(input(s))).rejects.toThrow(/exists/);
    expect(verifySet({ ...stored, tasks: stored.tasks.map((t, i) => (i === 0 ? { ...t, initialHeadSha: "f".repeat(40) } : t)) })).toMatchObject({ ok: false });
  });

  it("a host that stops answering mid-build (a plugin reload) stops the stratum and freezes nothing", async () => {
    const s = scenario();
    let warmed = 0;
    const dying = { run: (hostId: string, cwd: string, command: string, timeoutSec?: number) => {
      if (command.startsWith("git cat-file -e") && ++warmed > 1) return Promise.reject(new Error("plugin disposed"));
      return localHost.run(hostId, cwd, command, timeoutSec);
    } };
    const { report } = await buildSet(input(s, { host: dying }));
    expect(report.survived).toBe(1);
    expect(report.strata[0]).toMatchObject({ rejected: { host_error: 3 }, stoppedBecause: expect.stringContaining("plugin disposed") });
    expect(report.set).toBeNull();
    expect(report.note).toContain("stopped answering");
    expect(getSet(s.db as never, "v1")).toBeNull();
  });

  it("writes nothing on a dry run or a partial build", async () => {
    const s = scenario();
    const dry = await buildSet(input(s, { dryRun: true }));
    expect(dry.report.set).toBeNull();
    expect(getSet(s.db as never, "v1")).toBeNull();
  });
});

describe("bench stratification", () => {
  const cand = (id: string, hard: boolean, risk: Candidate["risk"]): Candidate => ({ taskId: id, runId: "r", projectId: BB, projectName: "x", attemptId: id, attemptNo: hard ? 2 : 1, hard, risk, area: "", repoPath: "/r", hostId: "h", initialHeadSha: "a", baseSha: null, contract: {} });
  const pool = [...Array.from({ length: 20 }, (_, i) => cand(`e${i}`, false, (["low", "medium", "high"] as const)[i % 3]!)), ...Array.from({ length: 8 }, (_, i) => cand(`h${i}`, true, (["low", "medium", "high"] as const)[i % 3]!))];

  it("keeps at least 30% hard tasks and a mix of risks, the same way twice", () => {
    const chosen = chooseFinal(pool, 10, "v1");
    expect(chosen).toHaveLength(10);
    expect(chosen.filter((c) => c.hard).length).toBeGreaterThanOrEqual(3);
    expect(new Set(chosen.map((c) => c.risk)).size).toBe(3);
    expect(chooseFinal(pool, 10, "v1").map((c) => c.taskId)).toEqual(chosen.map((c) => c.taskId));
    expect(chooseFinal(pool, 10, "other").map((c) => c.taskId)).not.toEqual(chosen.map((c) => c.taskId));
  });

  it("tries hard and easy candidates interleaved, and runs strata interleaved", () => {
    const order = warmOrder(pool, "v1");
    expect(order).toHaveLength(28);
    expect(order.slice(0, 10).filter((c) => c.hard).length).toBe(4);
    const mixed = interleave([{ stratum: "a", n: 1 }, { stratum: "a", n: 2 }, { stratum: "b", n: 3 }], ["a", "b"]);
    expect(mixed.map((t) => t.n)).toEqual([1, 3, 2]);
  });
});
