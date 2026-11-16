import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { createAttempt, createRun, createTask, openDatabase, transitionAttempt } from "../../src/rooms/plugin-db";
import { createRollback } from "../../src/rooms/rollback/server/rollback";
import { readRevertIntents, revertIntentKey, settleRevert, writeRevertIntent, type RevertIntent } from "../../src/rooms/rollback/store";
import { upsertAttemptChange } from "../../src/rooms/rollback/store";
import { runCommandOnHost } from "../../src/rooms/writer/cli-run";
import type { TaskV2 } from "../../src/rooms/contracts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
const task = (cwd: string): TaskV2 => ({ schema_version: 2, id: "dep", title: "dep", risk: "low", lane: "writer", project_cwd: cwd,
  read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["dependency.md"], owns_paths: ["dependency.md"], never_touch: [],
  depends_on: [], objective: "dep", acceptance: ["done"], verify: "none", verification: [] });

function setupRepo() {
  const repo = mkdtempSync(join(tmpdir(), "lp-revert-intent-"));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "base\n"); git(repo, "add", "README.md"); git(repo, "commit", "-q", "-m", "base");
  writeFileSync(join(repo, "dependency.md"), "dependency\n"); git(repo, "add", "dependency.md"); git(repo, "commit", "-q", "-m", "dependency");
  const changeSha = git(repo, "rev-parse", "HEAD");
  git(repo, "revert", "--no-edit", changeSha);
  const expectedCommit = git(repo, "rev-parse", "HEAD");
  const expectedTree = git(repo, "rev-parse", "HEAD^{tree}");
  return { repo, changeSha, expectedCommit, expectedTree };
}

function setupPreMergeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "lp-revert-premerge-"));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "base\n"); git(repo, "add", "README.md"); git(repo, "commit", "-q", "-m", "base");
  writeFileSync(join(repo, "dependency.md"), "dependency\n"); git(repo, "add", "dependency.md"); git(repo, "commit", "-q", "-m", "dependency");
  const baseHead = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "-q", "-c", "rollback-scratch"); git(repo, "revert", "--no-edit", baseHead);
  const expectedCommit = git(repo, "rev-parse", "HEAD");
  const expectedTree = git(repo, "rev-parse", "HEAD^{tree}");
  git(repo, "switch", "-q", "main");
  return { repo, baseHead, expectedCommit, expectedTree };
}

function setupDb(repo: string) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "P", "cli", repo);
  createTask(db, { id: "dep", runId: "run", kind: "bb", contract: task(repo) });
  createAttempt(db, { id: "dep-attempt", runId: "run", taskId: "dep" });
  transitionAttempt(db, "dep-attempt", "spawn_requested");
  transitionAttempt(db, "dep-attempt", "running");
  upsertAttemptChange(db as never, { attemptId: "dep-attempt", runId: "run", taskId: "dep" }, { mergeCommit: "a".repeat(40), outcome: "merged" });
  transitionAttempt(db, "dep-attempt", "accepted");
  return { bb, db };
}

const intent = (repo: string, expectedCommit: string, expectedTree: string): RevertIntent => ({
  opId: `run/dep/dep-attempt/${"a".repeat(40)}/${expectedCommit}`, runId: "run", taskId: "dep", projectId: "P", hostId: "h", basePath: repo,
  attemptIds: ["dep-attempt"], changeSha: "a".repeat(40), baseHead: git(repo, "rev-list", "--max-parents=0", "HEAD"), expectedCommit, expectedTree,
  trailer: "Lane-Pilot-Revert: dep", createdAt: Date.now(),
});

it("recovers a landed revert from a KV intent using actual Git and SQLite, then clears only that operation", async () => {
  const repo = setupRepo(); const { bb, db } = setupDb(repo.repo); const record = intent(repo.repo, repo.expectedCommit, repo.expectedTree);
  await writeRevertIntent(bb.storage.kv as never, record);
  const host = { call: async (method: string, input: { cwd: string; command: string }) => {
    if (method !== "runCommand") throw new Error(`unexpected ${method}`);
    return runCommandOnHost({ requestedHostId: "h", cwd: input.cwd, command: input.command, timeoutSec: 30 });
  } };
  const rollback = createRollback({ bb, db, host, log() {}, configForRun: async () => ({ hostId: "h" }) } as never, {} as never).rollback;
  expect(await rollback.recoverRevertIntents()).toEqual(["dep"]);
  expect((await readRevertIntents(bb.storage.kv as never, "run", "dep")).state).toBe("none");
  expect((db.prepare("SELECT outcome FROM lane_pilot_attempt_change WHERE attempt_id='dep-attempt'").get() as { outcome: string }).outcome).toBe("reverted");
  expect(db.prepare("SELECT count(*) AS n FROM lane_pilot_task_receipt WHERE task_id='dep' AND state='merged'").get()).toEqual({ n: 1 });
});

it("retains a lost-ack intent when the host is unknown, then settles on a later positive proof", async () => {
  const repo = setupRepo(); const { bb, db } = setupDb(repo.repo); const record = intent(repo.repo, repo.expectedCommit, repo.expectedTree);
  await writeRevertIntent(bb.storage.kv as never, record);
  let lost = true;
  const host = { call: async (method: string, input: { cwd: string; command: string }) => {
    if (lost) { lost = false; throw new Error("transport lost"); }
    return runCommandOnHost({ requestedHostId: "h", cwd: input.cwd, command: input.command, timeoutSec: 30 });
  } };
  const rollback = createRollback({ bb, db, host, log() {}, configForRun: async () => ({ hostId: "h" }) } as never, {} as never).rollback;
  expect(await rollback.recoverRevertIntents()).toEqual([]);
  expect((await readRevertIntents(bb.storage.kv as never, "run", "dep")).state).toBe("pending");
  expect(await rollback.recoverRevertIntents()).toEqual(["dep"]);
});

it("retains a pre-merge crash intent when the scratch commit exists but is not in base", async () => {
  const repo = setupPreMergeRepo(); const { bb, db } = setupDb(repo.repo);
  const record = { ...intent(repo.repo, repo.expectedCommit, repo.expectedTree), baseHead: repo.baseHead };
  await writeRevertIntent(bb.storage.kv as never, record);
  let probes = 0;
  const host = { call: async (method: string, input: { cwd: string; command: string }) => {
    if (method !== "runCommand") throw new Error(`unexpected ${method}`);
    probes++;
    return runCommandOnHost({ requestedHostId: "h", cwd: input.cwd, command: input.command, timeoutSec: 30 });
  } };
  const rollback = createRollback({ bb, db, host, log() {}, configForRun: async () => ({ hostId: "h" }) } as never, {} as never).rollback;
  expect(await rollback.recoverRevertIntents()).toEqual([]);
  expect(probes).toBe(1);
  expect((await readRevertIntents(bb.storage.kv as never, "run", "dep")).state).toBe("pending");
  expect((db.prepare("SELECT outcome FROM lane_pilot_attempt_change WHERE attempt_id='dep-attempt'").get() as { outcome: string }).outcome).toBe("merged");
});

it("retains wrong-host intent without probing that host", async () => {
  const repo = setupRepo(); const { bb, db } = setupDb(repo.repo);
  await writeRevertIntent(bb.storage.kv as never, { ...intent(repo.repo, repo.expectedCommit, repo.expectedTree), hostId: "wrong-host" });
  let probes = 0;
  const host = { call: async () => { probes++; throw new Error("must not probe wrong binding"); } };
  const rollback = createRollback({ bb, db, host, log() {}, configForRun: async () => ({ hostId: "h" }) } as never, {} as never).rollback;
  expect(await rollback.recoverRevertIntents()).toEqual([]);
  expect(probes).toBe(0);
  expect((await readRevertIntents(bb.storage.kv as never, "run", "dep")).state).toBe("pending");
});

it.each(["wrong-base", "orphan-attempt", "nonaccepted-attempt", "cross-run"] as const)("retains %s intent without settlement or host probing", async (kind) => {
  const repo = setupRepo(); const { bb, db } = setupDb(repo.repo);
  let record = intent(repo.repo, repo.expectedCommit, repo.expectedTree);
  if (kind === "wrong-base") record = { ...record, basePath: `${repo.repo}-other` };
  if (kind === "orphan-attempt") record = { ...record, attemptIds: ["missing-attempt"], opId: `${record.opId}/orphan` };
  if (kind === "nonaccepted-attempt") db.prepare("UPDATE lane_pilot_attempt SET state='blocked' WHERE id='dep-attempt'").run();
  if (kind === "cross-run") record = { ...record, runId: "other-run", opId: `other-run/${record.opId}` };
  await writeRevertIntent(bb.storage.kv as never, record);
  let probes = 0;
  const host = { call: async () => { probes++; throw new Error("must not probe an invalid binding"); } };
  const rollback = createRollback({ bb, db, host, log() {}, configForRun: async () => ({ hostId: "h" }) } as never, {} as never).rollback;
  expect(await rollback.recoverRevertIntents()).toEqual([]);
  expect(probes).toBe(0);
  expect((await readRevertIntents(bb.storage.kv as never, record.runId, record.taskId)).state).toBe("pending");
});

it("keeps a malformed matching KV record fail-closed", async () => {
  const repo = setupRepo(); const { bb } = setupDb(repo.repo); const record = intent(repo.repo, repo.expectedCommit, repo.expectedTree);
  await bb.storage.kv.set(revertIntentKey(record), { opId: record.opId, taskId: "dep" } as never);
  const result = await readRevertIntents(bb.storage.kv as never, "run", "dep");
  expect(result.state).toBe("unknown");
  expect(await bb.storage.kv.get(revertIntentKey(record))).toEqual({ opId: record.opId, taskId: "dep" });
});

it("does not partially settle SQLite when one attempt has mismatched provenance", () => {
  const repo = setupRepo(); const { db } = setupDb(repo.repo);
  expect(() => settleRevert(db as never, { projectId: "P", runId: "run", taskId: "dep", attemptIds: ["dep-attempt", "missing"], baseSha: "a".repeat(40), changeSha: "a".repeat(40), resultCommit: null, summary: "settle", detail: {} })).toThrow();
  expect(db.prepare("SELECT count(*) AS n FROM lane_pilot_task_receipt WHERE task_id='dep'").get()).toEqual({ n: 0 });
  expect((db.prepare("SELECT outcome FROM lane_pilot_attempt_change WHERE attempt_id='dep-attempt'").get() as { outcome: string }).outcome).toBe("merged");
});

it("fails before gitIntegrate when the strict intent write fails", async () => {
  const repo = setupRepo(); const { bb, db } = setupDb(repo.repo); const calls: string[] = [];
  bb.storage.kv.set = async () => { throw new Error("KV unavailable"); };
  const host = { call: async (method: string, input: { cwd?: string; command?: string }) => {
    calls.push(method);
    if (method === "gitCreateWorktree") return { status: "ready", path: repo.repo };
    if (method === "gitPrepareWorktree") return { status: "ready" };
    if (method === "gitRevertCommits") return { status: "reverted", commits: [repo.expectedCommit] };
    if (method === "runCommand") return { exitCode: 0, stdout: `COMMIT ${repo.expectedCommit}\nTREE ${repo.expectedTree}\n`, stderr: "" };
    if (method === "gitRemoveWorktree") return { status: "removed" };
    throw new Error(`unexpected ${method} ${input.command ?? ""}`);
  } };
  const rollback = createRollback({ bb, db, host, log() {}, configForRun: async () => ({ hostId: "h", projectId: "P", pmWorkspacePath: repo.repo, writerWorkspacePath: repo.repo, pmProviderId: "codex", pmModel: "codex", writerProviderId: "codex", writerModel: "codex" }) } as never,
    { resolveIntegrationGate: async () => null, runVerification: async () => [] } as never).rollback;
  const result = await rollback.revert("dep");
  expect(result).toMatchObject({ ok: false, state: "refused" });
  expect(calls).not.toContain("gitIntegrate");
});
