// Region 1 · Task graph, batch c: the life of one attempt, from the working copy to the barrier (ap_*, as_*, av_barrier).
// Each test checks the result the node's card names, on real git where the card is about a tree, on the real database where it is about a row.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRollback } from "../../src/rooms/rollback/server";
import { getAttemptChange } from "../../src/rooms/rollback/store";
import { createWorktree } from "../../src/rooms/verification/git-integrate";
import { candidatePath, createCandidates } from "../../src/rooms/phase/server/candidate";
import { contractSections } from "../../src/rooms/writer/server/writer-task";
import { routeAttemptFailure } from "../../src/rooms/writer/server/start-failure-route";
import { copyRefusedKeyPrefix } from "../../src/rooms/writer/server/copy-refused-key";
import { listOpenOwnerItems } from "../../src/rooms/owner-waiting";
import { createAttempt, createRun, createTask, getAttempt, setAttemptWorkspace, transitionAttempt } from "../../src/rooms/plugin-db";
import { getBaseline, insertBaseline } from "../../src/rooms/baseline/store";
import { turnedRed, type BaselineCheck } from "../../src/rooms/baseline/logic";
import { HOST, WS, fakeDb, git, scratchRepo, taskOf } from "./r01-world-c";

describe("the working copy of an attempt", () => {
  it("[sma:ap_copy] a copy is cut on its own lane/<name> branch from the named commit, and the founder's tree is not touched", async () => {
    const { dir, base, first, second } = scratchRepo();
    const target = join(dir, "wt", "app", "lpattempt_c1");
    const made = await createWorktree({ basePath: base, targetPath: target, name: "lpattempt_c1", commit: first });
    expect(made).toEqual({ status: "ready", path: target, branch: "lane/lpattempt_c1", reason: null, baseSha: first });
    // The copy stands on the older commit: b.txt is not there; its branch is its own.
    expect(existsSync(join(target, "a.txt"))).toBe(true);
    expect(existsSync(join(target, "b.txt"))).toBe(false);
    expect(git(base, "rev-parse", "lane/lpattempt_c1")).toBe(first);
    // The founder's tree: still on main, same commit, nothing changed in it.
    expect(git(base, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(base, "rev-parse", "HEAD")).toBe(second);
    expect(git(base, "status", "--porcelain")).toBe("");
    // Without a commit it forks from the checkout's HEAD.
    const head = await createWorktree({ basePath: base, targetPath: join(dir, "wt", "app", "lpattempt_c2"), name: "lpattempt_c2" });
    expect(head).toMatchObject({ status: "ready", branch: "lane/lpattempt_c2", baseSha: second });
  });

  it("[sma:ap_copy_refusal] a refused copy parks the attempt blocked and puts the reason before the owner once per refusal; another cause is another item, a workspace refusal is none", async () => {
    const { db } = fakeDb();
    createRun(db, "run1", "proj1", "bb", WS);
    createTask(db, { id: "task.copy", runId: "run1", kind: "bb", contract: taskOf("task.copy") });
    const refuse = async (attemptId: string, reason: string) => {
      createAttempt(db, { id: attemptId, runId: "run1", taskId: "task.copy" });
      transitionAttempt(db, attemptId, "spawn_requested");
      transitionAttempt(db, attemptId, "spawn_rejected", { reason });
      const state = { attemptId, last: { status: "spawn_rejected", reason } } as never;
      const deps = { ctx: { bb: {}, db, host: {}, log: () => undefined }, services: {} } as never;
      const out = await routeAttemptFailure(deps, state, { projectId: "proj1", runId: "run1", taskId: "task.copy" } as never,
        { failedBinding: null, redo: {} as never, sessionEnd: null, streamHandOff: false, turn: { failure: null, diff: null, streamError: false } } as never);
      return { out, state: state as unknown as { last: { status: string } } };
    };
    const open = () => listOpenOwnerItems(db, { kind: "copy_refused" });
    const first = await refuse("a1", "attempt_worktree_failed:path already exists");
    expect(first.out).toBe("break");
    expect(first.state.last.status).toBe("blocked");
    expect(getAttempt(db, "a1")).toMatchObject({ state: "blocked", reason: "attempt_worktree_failed:path already exists" });
    expect(open()).toHaveLength(1);
    expect(open()[0]).toMatchObject({ source: "writer", kind: "copy_refused", projectId: "proj1", what: "Рабочая копия для задачи не создалась" });
    expect(open()[0]!.key.startsWith(copyRefusedKeyPrefix("run1", "task.copy"))).toBe(true);
    expect(open()[0]!.why).toContain("Причина: path already exists.");
    // The identical refusal adds nothing; another cause is another item; a workspace refusal is not a copy refusal.
    await refuse("a2", "attempt_worktree_failed:path already exists");
    expect(open()).toHaveLength(1);
    await refuse("a3", "attempt_worktree_provision_failed:disk full");
    expect(open().map((item) => item.why.split(".")[0]).sort()).toEqual(["Причина: disk full", "Причина: path already exists"]);
    await refuse("a4", "attempt_workspace_missing:gone");
    expect(open()).toHaveLength(2);
  });

  it("[sma:ap_seat_candidate] a phase's verify copy is cut on its own phase/<id> branch inside the base checkout's .git, from the base's HEAD, and the base stays clean; a base whose .git is no folder cannot have one", async () => {
    const { base, second } = scratchRepo();
    const host = { call: async (method: string, input: Record<string, unknown>) => {
      if (method !== "runCommand") return {};
      const ran = spawnSync("sh", ["-c", String(input.command)], { cwd: String(input.cwd), encoding: "utf8" });
      return { hostId: HOST, exitCode: ran.status ?? -1, stdout: ran.stdout, stderr: ran.stderr };
    } };
    const candidates = createCandidates(host as never, HOST, { warn: () => undefined } as never);
    const tree = await candidates.ensure(base, "ph_c1");
    expect(tree).toEqual({ path: `${base}/.git/lp-phases/ph_c1`, startSha: second });
    expect(candidatePath(base, "ph_c1")).toBe(`${base}/.git/lp-phases/ph_c1`);
    expect(git(`${base}/.git/lp-phases/ph_c1`, "rev-parse", "--abbrev-ref", "HEAD")).toBe("phase/ph_c1");
    expect(git(base, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(git(base, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    // A second ensure finds the same tree.
    expect(await candidates.ensure(base, "ph_c1")).toEqual(tree);
    // A linked worktree's .git is a file: the phase cannot have its own branch there, for good.
    const linked = `${base}-linked`;
    git(base, "worktree", "add", "-q", "-b", "other", linked, "HEAD");
    const off = await candidates.ensure(linked, "ph_c2");
    expect(off).toMatchObject({ permanent: true });
    expect((off as { off: string }).off).toContain("the checkout's .git is not a folder");
  });

  it("[sma:ap_design_into_copy] a task that follows a drawing names its files as the first input, to read first; one without a drawing carries no such line", () => {
    const drawn = taskOf("d1", { drawing: ["design/ph/UI-SPEC.md", "design/ph/main.png"] });
    const lines = contractSections(drawn, false).inputs.split("\n");
    expect(lines).toContain("drawing: design/ph/UI-SPEC.md, design/ph/main.png — read it first; the screens you change match it, and the acceptance checks the drawing is unchanged.");
    expect(contractSections(taskOf("d2"), false).inputs.split("\n").filter((line) => line.startsWith("drawing:"))).toEqual([]);
  });

  it("[sma:ap_base] the commit a copy was cut from is recorded for the attempt; the first one stays, a missing one records nothing, and a continued attempt asks git once", async () => {
    const { bb, db } = fakeDb();
    createRun(db, "run1", "proj1", "bb", WS, "none", undefined, HOST);
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: taskOf("t1") });
    createAttempt(db, { id: "a1", runId: "run1", taskId: "t1" });
    createAttempt(db, { id: "a2", runId: "run1", taskId: "t1" });
    const asked: string[] = [];
    const host = { call: async (method: string, input: Record<string, unknown>) => { asked.push(`${method}:${String(input.projectCwd)}`); return { status: "ready", headSha: "b".repeat(40) }; } };
    const { rollback } = createRollback({ bb, db, host, log: () => undefined } as never, {} as never);
    const sha = "a".repeat(40);
    rollback.noteBase("a1", null);
    rollback.noteBase("ghost", sha);
    expect(getAttemptChange(db, "a1")).toBeUndefined();
    expect(getAttemptChange(db, "ghost")).toBeUndefined();
    rollback.noteBase("a1", sha);
    rollback.noteBase("a1", "f".repeat(40));
    expect(getAttemptChange(db, "a1")).toMatchObject({ attemptId: "a1", runId: "run1", taskId: "t1", baseSha: sha });
    // A continued attempt has no base of its own: git is asked in its workspace, once; a recorded one is not asked again.
    rollback.ensureBase("a2", HOST, "/wt/a2");
    await vi.waitFor(() => expect(getAttemptChange(db, "a2")?.baseSha).toBe("b".repeat(40)));
    rollback.ensureBase("a2", HOST, "/wt/a2");
    rollback.ensureBase("a1", HOST, "/wt/a1");
    await new Promise((done) => setTimeout(done, 20));
    expect(asked).toEqual(["gitOwnershipBase:/wt/a2"]);
  });

  it("[sma:ap_record_copy] the copy is written on the attempt row at once, once: a second binding, another path form or a running attempt changes nothing", () => {
    const { db } = fakeDb();
    createRun(db, "run1", "proj1", "bb", WS);
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: taskOf("t1") });
    createAttempt(db, { id: "a1", runId: "run1", taskId: "t1" });
    expect(getAttempt(db, "a1")).toMatchObject({ workspace_path: null, environment_id: null });
    expect(setAttemptWorkspace(db, "a1", { path: "/wt/a1", environmentId: "env1", decision: { kind: "worktree" } })).toBe(true);
    expect(getAttempt(db, "a1")).toMatchObject({ workspace_path: "/wt/a1", environment_id: "env1", workspace_decision: { kind: "worktree" } });
    expect(setAttemptWorkspace(db, "a1", { path: "/wt/other", environmentId: null, decision: {} })).toBe(false);
    expect(getAttempt(db, "a1")?.workspace_path).toBe("/wt/a1");
    expect(() => setAttemptWorkspace(db, "a1", { path: "relative/path", environmentId: null, decision: {} })).toThrow("absolute");
    // An attempt that is already running keeps no late binding.
    createAttempt(db, { id: "a2", runId: "run1", taskId: "t1" });
    transitionAttempt(db, "a2", "spawn_requested");
    transitionAttempt(db, "a2", "running", { threadId: "thr_w" });
    expect(setAttemptWorkspace(db, "a2", { path: "/wt/a2", environmentId: null, decision: {} })).toBe(false);
    expect(getAttempt(db, "a2")?.workspace_path).toBeNull();
  });

  it("[sma:ap_prered] the newest baseline of the task is the one read, from its own run and task; only a check green then and red now counts as new red", () => {
    const { db } = fakeDb();
    const check = (command: string, status: BaselineCheck["status"]): BaselineCheck => ({ command, cwd: WS, status, exitCode: status === "green" ? 0 : 1, note: "" });
    const put = (runId: string, taskId: string, summary: string, checks: BaselineCheck[]) => insertBaseline(db, { projectId: "proj1", runId, taskId, attemptId: null, baseSha: "abc", state: "ran", verdict: "red", mode: "t", action: "proceed", summary, checks, durationMs: 1 });
    put("run1", "T1", "older", [check("npm test", "red")]);
    put("run1", "T1", "newest", [check("npm test", "green"), check("npm run lint", "red")]);
    put("run2", "T1", "another run", []);
    put("run1", "T2", "another task", []);
    const latest = getBaseline(db, "run1", "T1")!;
    expect(latest.summary).toBe("newest");
    expect(latest.checks.map((row) => [row.command, row.status])).toEqual([["npm test", "green"], ["npm run lint", "red"]]);
    expect(getBaseline(db, "run1", "T3")).toBeUndefined();
    expect(turnedRed(latest.checks, [{ command: "npm test", exitCode: 1 }, { command: "npm run lint", exitCode: 1 }])).toEqual(["npm test"]);
  });
});
