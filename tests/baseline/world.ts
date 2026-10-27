import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { vi } from "vitest";
import { createBaselineRoom, type BaselineApi, type RegressionApi } from "../../src/rooms/baseline/server";
import { createRollback, type RollbackApi } from "../../src/rooms/rollback/server";
import { createAttempt, createRun, createTask, loadProjectSettings, openDatabase, saveProjectSetting } from "../../src/rooms/storage/database";
import { createWorktree, integrateWorktree, removeLaneWorktree } from "../../src/rooms/verification/git-integrate";
import { mergeInfo, revertCommitsInWorktree, worktreeState } from "../../src/rooms/verification/git-rollback";
import { bisectGateOnHost, runGateOnHost } from "../../src/rooms/verification/integration-gate-host";
import { resolveGitOwnershipBase } from "../../src/rooms/verification/git-ownership";
import { git } from "../verification/git-integrate-helpers";

export const HOST = "host-1";

/**
 * A real repository, real worktrees, a real `git bisect` and real shell checks stand in for the project host; only the host-call transport
 * is a function call. The runner is the checks run as shell commands in the cwd they are given (the sandbox is not under test here).
 */
export async function world(options: { settings?: Record<string, unknown> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "lp-baseline-"));
  const base = join(root, "project");
  git(root, "init", "-q", "-b", "main", base);
  await writeFile(join(base, "server.ts"), "line1\nline2\nline3\n");
  await writeFile(join(base, "keep.txt"), "keep\n");
  git(base, "add", "-A"); git(base, "commit", "-qm", "base");

  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run1", "projA", "bb", base, "none", undefined, HOST);
  for (const [key, value] of Object.entries(options.settings ?? {})) saveProjectSetting(db, "projA", key, value);

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
        case "gateBisect": return { hostId, ...await bisectGateOnHost({ basePath: input.basePath, command: input.command, goodSha: input.goodSha, badSha: input.badSha, timeoutSec: input.timeoutSec }) };
        default: throw new Error(`unexpected host call ${method}`);
      }
    },
  };
  const send = vi.fn(async () => ({}));
  const ran: string[] = [];
  const runs: Array<{ cwd: string; command: string }> = [];
  const ctx = {
    bb: { sdk: { threads: { send } }, storage: bb.storage }, db, host, log: () => undefined, isDisposed: () => false,
    configForRun: async (projectId: string) => ({ projectId, hostId: HOST, writerWorkspacePath: base }),
    effectiveProjectSettings: async (projectId: string, scopes: readonly string[] = []) => ({ values: loadProjectSettings(db, projectId, scopes) }),
  };
  const services: any = {
    runWriterPool: { acquire: async () => () => undefined },
    runVerification: async (_config: unknown, task: { verification: Array<{ command: string; cwd: string }> }) => task.verification.map((check) => {
      ran.push(check.command);
      runs.push({ cwd: check.cwd, command: check.command });
      const result = spawnSync("bash", ["-lc", check.command], { cwd: check.cwd, encoding: "utf8" });
      return { command: check.command, exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    }),
  };
  Object.assign(services, createRollback(ctx as never, services));
  Object.assign(services, createBaselineRoom(ctx as never, services));

  const contract = (id: string, verification: Array<string | { command: string; timeout_sec?: number; secrets?: string[] }>) => ({
    schema_version: 2, id, title: `title of ${id}`, risk: "low", lane: "server", project_cwd: base, read_first: [], interfaces: [], invariants: [], out_of_scope: [],
    expected_outputs: ["x"], owns_paths: ["**"], never_touch: [], depends_on: [], objective: id, acceptance: ["done"], verify: "tests",
    verification: verification.map((entry) => (typeof entry === "string" ? { command: entry, cwd: base } : { cwd: base, ...entry })),
  });

  /** A task whose writer worked in its own worktree and was merged and accepted. */
  async function acceptedTask(id: string, edit: (dir: string) => Promise<void>, verification: Array<string | { command: string; timeout_sec?: number }>) {
    createTask(db, { id, runId: "run1", kind: "bb", contract: contract(id, verification) });
    const attemptId = `att_${id}`;
    createAttempt(db, { id: attemptId, runId: "run1", taskId: id });
    const made = await createWorktree({ basePath: base, name: attemptId, targetPath: join(root, "wt", attemptId, "project") });
    services.rollback.noteBase(attemptId, made.baseSha);
    await edit(made.path!);
    const merged = await integrateWorktree({ basePath: base, worktreePath: made.path!, message: `${id}: title of ${id}\n\nLane-Pilot-Attempt: ${attemptId}`, removeWorktree: true });
    if (merged.status !== "merged") throw new Error(`merge of ${id} ended ${merged.status}`);
    services.rollback.noteMerge(attemptId, merged);
    db.prepare("UPDATE lane_pilot_attempt SET state='accepted', updated_at=? WHERE id=?").run(Date.now(), attemptId);
    return { attemptId, merged };
  }

  /** A task about to start: the row exists, nothing has run. */
  function pendingTask(id: string, verification: Array<string | { command: string; timeout_sec?: number; secrets?: string[] }>) {
    const task = contract(id, verification);
    createTask(db, { id, runId: "run1", kind: "bb", contract: task });
    createAttempt(db, { id: `att_${id}`, runId: "run1", taskId: id });
    return { projectId: "projA", runId: "run1", taskId: id, attemptId: `att_${id}`, pmThreadId: "thr_pm", config: { projectId: "projA", hostId: HOST, writerWorkspacePath: base } as never, task: task as never };
  }

  const worktrees = () => git(base, "worktree", "list").trim().split("\n").length;
  return {
    root, base, db, bb, calls, send, ran, runs, services: services as { baseline: BaselineApi; regression: RegressionApi; rollback: RollbackApi }, acceptedTask, pendingTask, worktrees,
    dispose: async () => { await harness.lifecycle.dispose(); await rm(root, { recursive: true, force: true }); },
  };
}
