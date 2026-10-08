import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { runCommandOnHost } from "../../src/cli-run";
import { createAttempt, createRun, getAttempt, listStageReceipts, openDatabase, saveTaskPlan, transitionAttempt } from "../../src/rooms/storage/database";
import { attemptMergeMessage, clearMergeIntent, createMergeIntentRecovery, mergeIntentKey, mergeLanded, recordMergeIntent, type MergeIntent, type RunOnHost } from "../../src/rooms/verification/server/merge-intent";
import { recordStage } from "../../src/server/stage-records";
import { integrateWorktree } from "../../src/rooms/verification/git-integrate";

// Real repositories: the proof that a merge landed is git's own answer, so the test asks git.
vi.setConfig({ testTimeout: 120_000 });

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
const run: RunOnHost = (hostId, cwd, command) => runCommandOnHost({ requestedHostId: hostId, cwd, command });

async function repo() {
  const root = await mkdtemp(join(tmpdir(), "lp-intent-"));
  const base = join(root, "main");
  execFileSync("git", ["init", "-q", "-b", "main", base]);
  await writeFile(join(base, "server.ts"), "line1\n");
  git(base, "add", "-A"); git(base, "commit", "-qm", "base");
  const worktree = async (name: string, branch = `lane/${name}`) => {
    const path = join(root, name);
    git(base, "worktree", "add", "-q", "-b", branch, path, "main");
    return path;
  };
  return { base, worktree };
}

const MESSAGE = attemptMergeMessage({ id: "T1", title: "Fix" }, "a1");
const intentFor = async (kv: Parameters<typeof recordMergeIntent>[0], base: string, wt: string, message = MESSAGE) => {
  await recordMergeIntent(kv, run, { attemptId: "a1", runId: "run", taskId: "T1", projectId: "proj", hostId: "h", basePath: base, worktreePath: wt, message });
  return await kv.get(mergeIntentKey("a1")) as MergeIntent;
};

describe("merge intent record", () => {
  it("keeps the base head, the attempt's head and branch before the merge, and drops them on completion", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const { base, worktree } = await repo();
    const wt = await worktree("a");
    const intent = await intentFor(bb.storage.kv as never, base, wt);
    expect(intent).toMatchObject({ attemptId: "a1", branch: "lane/a", baseHead: git(base, "rev-parse", "HEAD"), sha: git(wt, "rev-parse", "HEAD"), message: MESSAGE });
    await clearMergeIntent(bb.storage.kv as never, "a1");
    expect(await bb.storage.kv.get(mergeIntentKey("a1"))).toBeFalsy();
  });

  it("still records an intent when the machine does not answer", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    await recordMergeIntent(bb.storage.kv as never, async () => { throw new Error("host offline"); }, { attemptId: "a1", runId: "run", taskId: "T1", projectId: "proj", hostId: "h", basePath: "/x", worktreePath: "/y", message: "m" });
    expect(await bb.storage.kv.get(mergeIntentKey("a1"))).toMatchObject({ sha: null, branch: null, baseHead: null });
  });
});

describe("whether the work landed, asked of git", () => {
  it("is not landed before the merge, and not when loose edits were never committed", async () => {
    const { base, worktree } = await repo();
    const wt = await worktree("a");
    await writeFile(join(wt, "new.ts"), "x\n");
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const intent = await intentFor(bb.storage.kv as never, base, wt);
    expect(await mergeLanded(intent, run)).toEqual({ landed: false });
  });

  it("is landed once a committed attempt is merged, though its worktree and branch are gone", async () => {
    const { base, worktree } = await repo();
    const wt = await worktree("a");
    await writeFile(join(wt, "new.ts"), "x\n");
    git(wt, "add", "-A"); git(wt, "commit", "-qm", "work");
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const intent = await intentFor(bb.storage.kv as never, base, wt);
    expect((await integrateWorktree({ basePath: base, worktreePath: wt, message: MESSAGE, removeWorktree: true })).status).toBe("merged");
    expect(await mergeLanded(intent, run)).toMatchObject({ landed: true });
  });

  it("is landed when the writer's loose edits were committed and merged by the integration (the merge commit's attempt trailer is the witness)", async () => {
    const { base, worktree } = await repo();
    const wt = await worktree("a");
    await writeFile(join(wt, "new.ts"), "x\n");
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const intent = await intentFor(bb.storage.kv as never, base, wt);
    expect(intent.sha).toBe(intent.baseHead); // nothing committed yet: the heads alone prove nothing
    expect((await integrateWorktree({ basePath: base, worktreePath: wt, message: MESSAGE, removeWorktree: true })).status).toBe("merged");
    expect(await mergeLanded(intent, run)).toMatchObject({ landed: true, how: expect.stringContaining("merge commit") });
  });

  it("is landed after a rebase rewrote the attempt's commit (the worktree's tip is the witness)", async () => {
    const { base, worktree } = await repo();
    const wt = await worktree("a");
    const other = await worktree("b");
    await writeFile(join(wt, "a.ts"), "a\n"); git(wt, "add", "-A"); git(wt, "commit", "-qm", "a");
    await writeFile(join(other, "b.ts"), "b\n"); git(other, "add", "-A"); git(other, "commit", "-qm", "b");
    expect((await integrateWorktree({ basePath: base, worktreePath: other, message: "b" })).status).toBe("merged");
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const intent = await intentFor(bb.storage.kv as never, base, wt, "a");
    expect((await integrateWorktree({ basePath: base, worktreePath: wt, message: "a" })).status).toBe("merged");
    expect(await mergeLanded(intent, run)).toMatchObject({ landed: true, how: expect.stringContaining("worktree tip") });
  });

  // Audit 2026-10-08, item 2: a worktree is made from main's head of that day; when another task merged since, the
  // fork point is an ancestor of main (and not main's head) without anything of this attempt being in main.
  it("is not landed when main moved on after the worktree was made and the merge never ran (loose edits only)", async () => {
    const { base, worktree } = await repo();
    const wt = await worktree("a");
    const other = await worktree("b");
    await writeFile(join(wt, "a.ts"), "a\n");
    await writeFile(join(other, "b.ts"), "b\n"); git(other, "add", "-A"); git(other, "commit", "-qm", "b");
    expect((await integrateWorktree({ basePath: base, worktreePath: other, message: "b" })).status).toBe("merged");
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const intent = await intentFor(bb.storage.kv as never, base, wt);
    expect(intent.sha).not.toBe(intent.baseHead); // the fork point is behind main
    expect(await mergeLanded(intent, run)).toEqual({ landed: false });
  });

  it("is not landed when main moved on and the attempt's worktree is clean at the fork point", async () => {
    const { base, worktree } = await repo();
    const wt = await worktree("a");
    const other = await worktree("b");
    await writeFile(join(other, "b.ts"), "b\n"); git(other, "add", "-A"); git(other, "commit", "-qm", "b");
    expect((await integrateWorktree({ basePath: base, worktreePath: other, message: "b" })).status).toBe("merged");
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const intent = await intentFor(bb.storage.kv as never, base, wt);
    expect(await mergeLanded(intent, run)).toEqual({ landed: false });
  });

  it("is not landed when main moved on after the intent and the attempt's own commit is not in main", async () => {
    const { base, worktree } = await repo();
    const wt = await worktree("a");
    const other = await worktree("b");
    await writeFile(join(wt, "a.ts"), "a\n"); git(wt, "add", "-A"); git(wt, "commit", "-qm", "a");
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const intent = await intentFor(bb.storage.kv as never, base, wt);
    await writeFile(join(other, "b.ts"), "b\n"); git(other, "add", "-A"); git(other, "commit", "-qm", "b");
    expect((await integrateWorktree({ basePath: base, worktreePath: other, message: "b" })).status).toBe("merged");
    expect(await mergeLanded(intent, run)).toEqual({ landed: false });
  });

  it("does not take another attempt's trailer, or a longer id with the same prefix, for this attempt's merge", async () => {
    const { base, worktree } = await repo();
    const wt = await worktree("a");
    const other = await worktree("b");
    await writeFile(join(other, "b.ts"), "b\n");
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const intent = await intentFor(bb.storage.kv as never, base, wt);
    expect((await integrateWorktree({ basePath: base, worktreePath: other, message: attemptMergeMessage({ id: "T2", title: "Other" }, "a10") })).status).toBe("merged");
    expect(await mergeLanded(intent, run)).toEqual({ landed: false });
  });

  it("is unknown when the machine does not answer", async () => {
    const intent = { attemptId: "a1", runId: "r", taskId: "T", projectId: "p", hostId: "h", basePath: "/x", worktreePath: "/y", branch: null, sha: null, baseHead: null, message: "m", at: 0 };
    expect(await mergeLanded(intent, async () => { throw new Error("offline"); })).toEqual({ unknown: true });
  });
});

describe("recovery of a merge whose reply was lost", () => {
  async function setup() {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: { send: async () => ({}) } } as never });
    const db = openDatabase(bb);
    const { base, worktree } = await repo();
    createRun(db, "run", "proj", "cli", base);
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id='pm' WHERE id='run'").run();
    db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES('T1','run','bb','{}',1)").run();
    saveTaskPlan(db, "T1", "Fix");
    for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) recordStage(db, { runId: "run", taskId: "T1", stageId, state: "pending", input: "Fix" });
    createAttempt(db, { id: "a1", runId: "run", taskId: "T1" });
    for (const state of ["spawn_requested", "running"]) transitionAttempt(db, "a1", state);
    const maintained: string[] = [];
    const services = { activeWriterTasks: new Set<string>(), maintainMemoryAfterAcceptance: (_p: string, _r: string, task: string) => { maintained.push(task); }, maintainProjectLifeAfterAcceptance: () => undefined };
    const ctx = { bb, db, log: () => undefined, host: { call: (_method: string, input: { requestedHostId: string; cwd: string; command: string }) => runCommandOnHost(input) }, refreshRun: () => undefined } as never;
    const { recoverMergeIntents } = createMergeIntentRecovery(ctx, services as never);
    return { bb, db, base, worktree, recoverMergeIntents, services, maintained };
  }

  it("accepts the attempt with a receipt, closes its stages and drops the intent, once", async () => {
    const { bb, db, base, worktree, recoverMergeIntents, maintained } = await setup();
    const wt = await worktree("a");
    await writeFile(join(wt, "new.ts"), "x\n");
    await intentFor(bb.storage.kv as never, base, wt);
    // gitIntegrate merged, then the reply was lost (a reload): the attempt is still «running».
    expect((await integrateWorktree({ basePath: base, worktreePath: wt, message: MESSAGE, removeWorktree: true })).status).toBe("merged");
    expect(getAttempt(db, "a1")?.state).toBe("running");

    expect(await recoverMergeIntents()).toEqual(["T1"]);
    expect(getAttempt(db, "a1")?.state).toBe("accepted");
    expect(listStageReceipts(db, "run", "T1").filter((row) => ["writer-agent", "verification", "acceptance-receipt"].includes(row.stageId)).map((row) => row.state)).toEqual(["passed", "passed", "passed"]);
    const gate = db.prepare("SELECT gate, status FROM lane_pilot_gate_event WHERE task_id='T1'").all();
    expect(gate).toMatchObject([{ gate: "accept", status: "passed" }]);
    expect(await bb.storage.kv.get(mergeIntentKey("a1"))).toBeFalsy();
    expect(maintained).toEqual(["T1"]);
    // No double accept: a second pass finds nothing.
    expect(await recoverMergeIntents()).toEqual([]);
    expect(maintained).toEqual(["T1"]);
  });

  it("leaves an attempt whose merge did not land to the ordinary recovery, and drops the intent", async () => {
    const { bb, db, base, worktree, recoverMergeIntents } = await setup();
    const wt = await worktree("a");
    await writeFile(join(wt, "new.ts"), "x\n");
    await intentFor(bb.storage.kv as never, base, wt);
    expect(await recoverMergeIntents()).toEqual([]);
    expect(getAttempt(db, "a1")?.state).toBe("running");
    expect(await bb.storage.kv.get(mergeIntentKey("a1"))).toBeFalsy();
  });

  it("keeps the intent while a loop of this process works on the task, and while the machine is silent", async () => {
    const { bb, db, base, worktree, recoverMergeIntents, services } = await setup();
    const wt = await worktree("a");
    await writeFile(join(wt, "new.ts"), "x\n");
    await intentFor(bb.storage.kv as never, base, wt);
    await integrateWorktree({ basePath: base, worktreePath: wt, message: MESSAGE, removeWorktree: true });
    services.activeWriterTasks.add("run:T1");
    expect(await recoverMergeIntents()).toEqual([]);
    expect(getAttempt(db, "a1")?.state).toBe("running");
    expect(await bb.storage.kv.get(mergeIntentKey("a1"))).toBeTruthy();
    services.activeWriterTasks.clear();
    // A merge cut off a moment ago may still run on the machine: the periodic pass gives it a grace.
    expect(await recoverMergeIntents({ graceMs: 3_600_000 })).toEqual([]);
    expect(getAttempt(db, "a1")?.state).toBe("running");
    expect(await recoverMergeIntents()).toEqual(["T1"]);
  });

  it("only drops the intent of an attempt that is already accepted", async () => {
    const { bb, db, base, worktree, recoverMergeIntents } = await setup();
    const wt = await worktree("a");
    await intentFor(bb.storage.kv as never, base, wt);
    transitionAttempt(db, "a1", "accepted");
    expect(await recoverMergeIntents()).toEqual([]);
    expect(await bb.storage.kv.get(mergeIntentKey("a1"))).toBeFalsy();
  });
});
