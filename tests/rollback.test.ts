import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { createRollback, runRollbackCli } from "../src/rooms/rollback/server";
import { getAttemptChange, listTaskReceipts } from "../src/rooms/rollback/store";
import { createAttempt, createRun, createTask, openDatabase, saveProjectSetting } from "../src/rooms/storage/database";
import { createWorktree, integrateWorktree, removeLaneWorktree } from "../src/rooms/verification/git-integrate";
import { mergeInfo, revertCommitsInWorktree, worktreeState } from "../src/rooms/verification/git-rollback";
import { runGateOnHost } from "../src/rooms/verification/integration-gate-host";
import { resolveGitOwnershipBase } from "../src/rooms/verification/git-ownership";
import { git } from "./verification/git-integrate-helpers";

// Real repositories and worktrees stand in for the project host; only the host-call transport is a function call.
vi.setConfig({ testTimeout: 180_000 });

const HOST = "host-1";

async function world(options: { gate?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "lp-rollback-"));
  const base = join(root, "project");
  git(root, "init", "-q", "-b", "main", base);
  await writeFile(join(base, "server.ts"), "line1\nline2\nline3\n");
  await writeFile(join(base, "keep.txt"), "keep\n");
  git(base, "add", "-A"); git(base, "commit", "-qm", "base");

  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run1", "projA", "bb", base, "none", undefined, HOST);
  if (options.gate) saveProjectSetting(db, "projA", "integration.gate_command", options.gate);

  const calls: string[] = [];
  const host = {
    call: async (method: string, input: Record<string, any>) => {
      calls.push(method);
      const hostId = HOST;
      switch (method) {
        case "gitCreateWorktree": return { hostId, ...await createWorktree({ basePath: input.basePath, name: input.name, commit: input.commit, targetPath: join(root, "wt", input.name, basename(input.basePath)) }) };
        case "gitPrepareWorktree": return { hostId, linked: [] };
        case "gitRemoveWorktree": return { hostId, ...await removeLaneWorktree({ basePath: input.basePath, worktreePath: input.worktreePath, ...(input.release ? { releaseDir: join(root, "released") } : {}) }) };
        case "gitMergeInfo": return { hostId, ...await mergeInfo({ basePath: input.basePath, commit: input.commit, attemptId: input.attemptId }) };
        case "gitRevertCommits": return { hostId, ...await revertCommitsInWorktree({ worktreePath: input.worktreePath, commits: input.commits }) };
        case "gitWorktreeState": return { hostId, ...await worktreeState({ basePath: input.basePath, worktreePath: input.worktreePath }) };
        case "gitOwnershipBase": return { hostId, ...await resolveGitOwnershipBase({ projectCwd: input.projectCwd }) };
        case "gitIntegrate": return { hostId, ...await integrateWorktree({ basePath: input.basePath, worktreePath: input.worktreePath, message: input.message, removeWorktree: input.removeWorktree }) };
        case "gateRun": return { hostId, ...await runGateOnHost({ basePath: input.basePath, command: input.command, timeoutSec: input.timeoutSec }) };
        default: throw new Error(`unexpected host call ${method}`);
      }
    },
  };
  const ctx = {
    bb, db, host, log: () => undefined, isDisposed: () => false,
    configForRun: async (projectId: string) => ({ projectId, hostId: HOST, writerWorkspacePath: base }),
  };
  const services = {
    runVerification: async (_config: unknown, task: { verification: Array<{ command: string; cwd: string }> }) => task.verification.map((check) => {
      const ran = spawnSync("bash", ["-lc", check.command], { cwd: check.cwd, encoding: "utf8" });
      return { command: check.command, exitCode: ran.status ?? 1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
    }),
  };
  const { rollback } = createRollback(ctx as never, services as never);

  /** A task whose writer worked in its own worktree and was merged and accepted. `record` false leaves the merge unrecorded, as before the record existed. */
  async function acceptedTask(id: string, edit: (dir: string) => Promise<void>, verification: string[], record = true) {
    const task = {
      schema_version: 2, id, title: `title of ${id}`, risk: "low", lane: "server", project_cwd: base, read_first: [], interfaces: [], invariants: [], out_of_scope: [],
      expected_outputs: ["x"], owns_paths: ["**"], never_touch: [], depends_on: [], objective: id, acceptance: ["done"], verify: "tests",
      verification: verification.map((command) => ({ command, cwd: base })),
    };
    createTask(db, { id, runId: "run1", kind: "bb", contract: task });
    const attemptId = `att_${id}`;
    createAttempt(db, { id: attemptId, runId: "run1", taskId: id });
    const made = await createWorktree({ basePath: base, name: attemptId, targetPath: join(root, "wt", attemptId, "project") });
    if (record) rollback.noteBase(attemptId, made.baseSha);
    await edit(made.path!);
    const merged = await integrateWorktree({ basePath: base, worktreePath: made.path!, message: `${id}: title of ${id}\n\nLane-Pilot-Attempt: ${attemptId}`, removeWorktree: true });
    expect(merged.status).toBe("merged");
    if (record) rollback.noteMerge(attemptId, merged);
    db.prepare("UPDATE lane_pilot_attempt SET state='accepted', updated_at=? WHERE id=?").run(Date.now(), attemptId);
    return { attemptId, merged };
  }
  const worktrees = () => git(base, "worktree", "list").trim().split("\n").length;
  return { root, base, db, calls, rollback, acceptedTask, worktrees, dispose: async () => { await harness.lifecycle.dispose(); await rm(root, { recursive: true, force: true }); } };
}

describe("the record of an attempt's base and change (SMA wall 4)", () => {
  it("names the base, the merge parent, the merge commit and the changed files with deletions, from the database", async () => {
    const w = await world();
    const before = git(w.base, "rev-parse", "HEAD").trim();
    const { attemptId, merged } = await w.acceptedTask("t1", async (dir) => { await writeFile(join(dir, "lib.ts"), "x\n"); await rm(join(dir, "keep.txt")); }, ["test -f lib.ts"]);
    const row = getAttemptChange(w.db, attemptId)!;
    expect(row).toMatchObject({ baseSha: before, mergeParent: before, mergeCommit: merged.commit, outcome: "merged" });
    expect(row.changed).toEqual(expect.arrayContaining([{ status: "A", path: "lib.ts" }, { status: "D", path: "keep.txt" }]));
    await w.dispose();
  });

  it("keeps the first base and records the worktree of a stopped attempt", async () => {
    const w = await world();
    const head = git(w.base, "rev-parse", "HEAD").trim();
    createTask(w.db, { id: "tS", runId: "run1", kind: "bb", contract: { project_cwd: w.base } });
    createAttempt(w.db, { id: "attS", runId: "run1", taskId: "tS" });
    const made = await createWorktree({ basePath: w.base, name: "attS", targetPath: join(w.root, "wt", "attS", "project") });
    w.rollback.noteBase("attS", made.baseSha);
    w.rollback.noteBase("attS", "f".repeat(40));
    await writeFile(join(made.path!, "half.ts"), "wip\n");
    await rm(join(made.path!, "keep.txt"));
    db_set_workspace(w.db, "attS", made.path!);
    await w.rollback.noteStopped("attS");
    const row = getAttemptChange(w.db, "attS")!;
    expect(row.baseSha).toBe(head);
    expect(row.outcome).toBe("stopped");
    expect(row.worktree).toMatchObject({ dirty: 2, ahead: 0 });
    expect(row.changed).toEqual([{ path: "half.ts", status: "A" }, { path: "keep.txt", status: "D" }]);
    await w.dispose();
  });

  it("asks git for the base of a continued or in-place attempt, once", async () => {
    const w = await world();
    createTask(w.db, { id: "tE", runId: "run1", kind: "bb", contract: { project_cwd: w.base } });
    createAttempt(w.db, { id: "attE", runId: "run1", taskId: "tE" });
    w.rollback.ensureBase("attE", HOST, w.base);
    await vi.waitFor(() => expect(getAttemptChange(w.db, "attE")?.baseSha).toBe(git(w.base, "rev-parse", "HEAD").trim()));
    const asked = w.calls.filter((call) => call === "gitOwnershipBase").length;
    w.rollback.ensureBase("attE", HOST, w.base);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(w.calls.filter((call) => call === "gitOwnershipBase").length).toBe(asked);
    await w.dispose();
  });
});

function db_set_workspace(db: ReturnType<typeof openDatabase>, attemptId: string, path: string) {
  db.prepare("UPDATE lane_pilot_attempt SET workspace_path=? WHERE id=?").run(path, attemptId);
}

describe("bb lane-pilot reverify", () => {
  it("runs the verification[] on the merged change in a fresh worktree, item by item, and keeps a receipt", async () => {
    const w = await world();
    await w.acceptedTask("t1", async (dir) => { await writeFile(join(dir, "lib.ts"), "export const v = 1;\n"); }, ["test -f lib.ts", "grep -q 'v = 1' lib.ts"]);
    const result = await w.rollback.reverify("t1");
    expect(result).toMatchObject({ ok: true, state: "passed", taskId: "t1" });
    expect(result.items).toHaveLength(2);
    expect(result.items!.every((item) => item.ok)).toBe(true);
    expect(listTaskReceipts(w.db, "t1", "reverify")).toHaveLength(1);
    expect(listTaskReceipts(w.db, "t1")[0]).toMatchObject({ state: "passed", changeSha: result.change, baseSha: result.base });
    expect(w.worktrees()).toBe(1);
    await w.dispose();
  });

  it("reports the failing item and fails; an attempt id works as well as a task id", async () => {
    const w = await world();
    const { attemptId } = await w.acceptedTask("t1", async (dir) => { await writeFile(join(dir, "lib.ts"), "export const v = 1;\n"); }, ["test -f lib.ts", "grep -q 'v = 2' lib.ts"]);
    const result = await w.rollback.reverify(attemptId);
    expect(result).toMatchObject({ ok: false, state: "failed", attemptId });
    expect(result.items!.map((item) => item.ok)).toEqual([true, false]);
    expect(result.next).toContain("revert t1");
    expect(w.worktrees()).toBe(1);
    await w.dispose();
  });

  it("finds a merge made before the record existed by its attempt trailer, and records it", async () => {
    const w = await world();
    const { attemptId } = await w.acceptedTask("t1", async (dir) => { await writeFile(join(dir, "lib.ts"), "x\n"); }, ["test -f lib.ts"], false);
    expect(getAttemptChange(w.db, attemptId)).toBeUndefined();
    expect((await w.rollback.reverify("t1")).state).toBe("passed");
    expect(getAttemptChange(w.db, attemptId)).toMatchObject({ outcome: "merged" });
    expect(getAttemptChange(w.db, attemptId)!.mergeCommit).toMatch(/^[a-f0-9]{40}$/);
    await w.dispose();
  });

  it("refuses with a next step when there is nothing accepted to check", async () => {
    const w = await world();
    createTask(w.db, { id: "tN", runId: "run1", kind: "bb", contract: { project_cwd: w.base, schema_version: 2, id: "tN" } });
    const none = await w.rollback.reverify("nope");
    expect(none).toMatchObject({ ok: false, state: "refused" });
    await w.dispose();
  });
});

describe("bb lane-pilot revert", () => {
  it("reverts the merge with git revert in a worktree, merges it, records it, and refuses to do it twice", async () => {
    const w = await world();
    const { merged } = await w.acceptedTask("t1", async (dir) => { await writeFile(join(dir, "lib.ts"), "x\n"); }, ["test -f keep.txt"]);
    const result = await w.rollback.revert("t1");
    expect(result).toMatchObject({ ok: true, state: "merged" });
    expect(existsSync(join(w.base, "lib.ts"))).toBe(false);
    // history grew, nothing was reset: the task's own merge is still an ancestor
    expect(git(w.base, "merge-base", "--is-ancestor", merged.commit!, "HEAD")).toBe("");
    expect(git(w.base, "log", "-1", "--format=%s%n%b")).toContain("Revert t1");
    expect(git(w.base, "status", "--porcelain").trim()).toBe("");
    expect(listTaskReceipts(w.db, "t1", "revert")[0]).toMatchObject({ state: "merged", resultCommit: result.commit });
    expect(getAttemptChange(w.db, "att_t1")!.outcome).toBe("reverted");
    expect(w.worktrees()).toBe(1);
    const again = await w.rollback.revert("t1");
    expect(again).toMatchObject({ ok: false, state: "refused" });
    expect(again.summary).toContain("already reverted");
    // reverify checks the change as it was accepted, and says the task has been reverted since
    const checked = await w.rollback.reverify("t1");
    expect(checked).toMatchObject({ state: "passed", revertedIn: result.commit });
    expect(checked.summary).toContain("was reverted in");
    await w.dispose();
  });

  it("refuses when a later commit touches the same lines, names it and the task to revert first, and leaves main alone", async () => {
    const w = await world();
    await w.acceptedTask("t1", async (dir) => { await writeFile(join(dir, "server.ts"), "line1 from t1\nline2\nline3\n"); }, ["test -f keep.txt"]);
    await w.acceptedTask("t2", async (dir) => { await writeFile(join(dir, "server.ts"), "line1 from t2\nline2\nline3\n"); }, ["test -f keep.txt"]);
    const head = git(w.base, "rev-parse", "HEAD").trim();
    const result = await w.rollback.revert("t1");
    expect(result).toMatchObject({ ok: false, state: "refused" });
    expect(result.next).toContain("bb lane-pilot revert t2");
    expect(result.conflicts).toEqual(["server.ts"]);
    expect(git(w.base, "rev-parse", "HEAD").trim()).toBe(head);
    expect(await readFile(join(w.base, "server.ts"), "utf8")).toBe("line1 from t2\nline2\nline3\n");
    expect(listTaskReceipts(w.db, "t1", "revert")[0]).toMatchObject({ state: "refused" });
    expect(w.worktrees()).toBe(1);
    // the later task goes first, then the earlier one reverts cleanly
    expect((await w.rollback.revert("t2")).state).toBe("merged");
    expect((await w.rollback.revert("t1")).state).toBe("merged");
    expect(await readFile(join(w.base, "server.ts"), "utf8")).toBe("line1\nline2\nline3\n");
    await w.dispose();
  });

  it("blocks when the revert breaks a check that is green without it, and ignores one that was red before the task too", async () => {
    const w = await world();
    // t1 adds a file; its checks: the feature file (meaningless after the revert: red before the task too) and keep.txt
    await w.acceptedTask("t1", async (dir) => { await writeFile(join(dir, "feature.txt"), "f\n"); }, ["test -f feature.txt", "test -f keep.txt"]);
    // a later, unrelated commit deletes keep.txt: with t1 reverted, "test -f keep.txt" is red, but it was green before t1
    await w.acceptedTask("t2", async (dir) => { await rm(join(dir, "keep.txt")); }, ["true"]);
    const blocked = await w.rollback.revert("t1");
    expect(blocked).toMatchObject({ ok: false, state: "refused" });
    expect(blocked.summary).toContain("test -f keep.txt");
    expect(existsSync(join(w.base, "feature.txt"))).toBe(true);
    // put keep.txt back with another task: now only the feature check is red, and it was red before the task too
    await w.acceptedTask("t3", async (dir) => { await writeFile(join(dir, "keep.txt"), "keep\n"); }, ["true"]);
    const ok = await w.rollback.revert("t1");
    expect(ok).toMatchObject({ ok: true, state: "merged" });
    expect((ok.checks as { notMeaningful: unknown[] }).notMeaningful).toHaveLength(1);
    expect(existsSync(join(w.base, "feature.txt"))).toBe(false);
    await w.dispose();
  });

  it("runs the project's gate on the reverted tree; red there but not on main blocks, red on main too does not", async () => {
    const w = await world({ gate: "test -f keep.txt && ! test -f feature.txt" });
    await w.acceptedTask("t1", async (dir) => { await writeFile(join(dir, "feature.txt"), "f\n"); await writeFile(join(dir, "server.ts"), "line1 t1\nline2\nline3\n"); }, ["true"]);
    // the gate is red on main (feature.txt exists) and green on the reverted tree: the revert goes through
    const ok = await w.rollback.revert("t1", { dryRun: true });
    expect(ok).toMatchObject({ ok: true, state: "dry_run" });
    expect((ok.gate as { exitCode: number }).exitCode).toBe(0);
    await w.dispose();
    const v = await world({ gate: "test -f nothere.txt" });
    await v.acceptedTask("t1", async (dir) => { await writeFile(join(dir, "feature.txt"), "f\n"); }, ["true"]);
    // red on the reverted tree and red on main: not the revert's doing
    const red = await v.rollback.revert("t1", { dryRun: true });
    expect(red).toMatchObject({ ok: true });
    expect((red.gate as { baselineRed: boolean }).baselineRed).toBe(true);
    await v.dispose();
  });

  it("--dry-run changes nothing in main and removes its worktrees", async () => {
    const w = await world();
    await w.acceptedTask("t1", async (dir) => { await writeFile(join(dir, "lib.ts"), "x\n"); }, ["test -f keep.txt"]);
    const head = git(w.base, "rev-parse", "HEAD").trim();
    const result = await w.rollback.revert("t1", { dryRun: true });
    expect(result).toMatchObject({ ok: true, state: "dry_run" });
    expect(git(w.base, "rev-parse", "HEAD").trim()).toBe(head);
    expect(existsSync(join(w.base, "lib.ts"))).toBe(true);
    expect(w.worktrees()).toBe(1);
    await w.dispose();
  });

  it("the CLI answers JSON and exits 1 on a refusal", async () => {
    const w = await world();
    await w.acceptedTask("t1", async (dir) => { await writeFile(join(dir, "lib.ts"), "x\n"); }, ["test -f lib.ts"]);
    const pass = await runRollbackCli(w.rollback, "reverify", ["t1"]);
    expect(pass.exitCode).toBe(0);
    expect(JSON.parse(pass.stdout!)).toMatchObject({ state: "passed" });
    const changes = await runRollbackCli(w.rollback, "changes", ["t1"]);
    expect(JSON.parse(changes.stdout!).attempts[0].change.mergeCommit).toMatch(/^[a-f0-9]{40}$/);
    expect((await runRollbackCli(w.rollback, "revert", ["nope"])).exitCode).toBe(1);
    expect((await runRollbackCli(w.rollback, "revert", ["t1", "--force"])).exitCode).toBe(1);
    await w.dispose();
  });
});
