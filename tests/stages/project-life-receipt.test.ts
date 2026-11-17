import { execFileSync } from "node:child_process";
import { stageHelperSettings } from "../../src/rooms/settings/server/stage-settings";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { validateStageReceipt } from "@lane-pilot/contracts";
import { describe, expect, it } from "vitest";
import { createProjectLifeStage } from "../../src/rooms/project-life/server/project-life";
import { createAttempt, createRun, createTask, listStageReceipts, openDatabase, recordFinishedAttempt, saveStageReceipt, setAttemptWorkspace, setRunThread, setRunWorkspace } from "../../src/rooms/plugin-db";
import { recordStage } from "../../src/rooms/runs/server/stage-records";
import type { Services } from "../../server";
import type { ServerCore } from "../../src/rooms/contracts/server";
import receipt from "../fixtures/stage-left-open/muse-session-sync.json";

// Hub list_run_stages, 2026-11-03: accepted task, pending project-life, no child or result.
// Only the workspace and the task's unrelated product contract are replaced for local replay.
function setup(fail: boolean, prior: "missing" | "pending" | "running", layout: "run-root" | "normal-section" | "repo-root" = "run-root", response: "commit" | "none" | "fail-none" = "commit") {
  const dir = mkdtempSync(join(tmpdir(), "lp-life-receipt-"));
  const runPath = layout === "run-root" ? dir : join(dir, "apps/bot");
  const taskProjectCwd = layout === "repo-root" ? dir : runPath;
  const acceptedWorktree = layout === "run-root" ? null : join(dir, ".attempt-worktree-removed");
  mkdirSync(runPath, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "test@local.invalid");
  git("config", "user.name", "test");
  git("commit", "-q", "--allow-empty", "-m", "base");
  const pmThreadId = "thr_q4w86he7i7", projectId = "proj_ejbam66722";
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: {
    hosts: { list: async () => [] },
    threads: { getPluginMetadata: async () => ({ role: "pm", lanePilotRunId: receipt.runId }) },
  } as never });
  const db = openDatabase(bb);
  createRun(db, receipt.runId, projectId, "bb", runPath);
  setRunThread(db, receipt.runId, pmThreadId);
  setRunWorkspace(db, receipt.runId, runPath, "local-env");
  createTask(db, { id: receipt.taskId, runId: receipt.runId, kind: "bb", contract: {
    schema_version: 2, id: receipt.taskId, title: "Muse session sync", objective: "Sync session",
    risk: "low", lane: "writer", project_cwd: taskProjectCwd, ...(layout === "repo-root" ? { repo_scope: true } : {}), read_first: ["README.md"], interfaces: [], invariants: [],
    out_of_scope: [], expected_outputs: ["session.ts"], owns_paths: ["session.ts"], never_touch: [],
    depends_on: [], acceptance: ["Session sync works"], verify: "none", verification: [],
  } });
  if (acceptedWorktree) {
    createAttempt(db, { id: `${receipt.taskId}-accepted`, runId: receipt.runId, taskId: receipt.taskId });
    setAttemptWorkspace(db, `${receipt.taskId}-accepted`, { path: acceptedWorktree, environmentId: null, decision: { removedAfterMerge: true } });
    recordFinishedAttempt(db, `${receipt.taskId}-accepted`, "accepted");
  }
  recordStage(db, { runId: receipt.runId, taskId: receipt.taskId, stageId: "acceptance-receipt", state: "passed", input: "accepted" });
  if (prior !== "missing") saveStageReceipt(db, validateStageReceipt({ ...receipt, state: prior }));
  let calls = 0;
  const commandCwds: string[] = [];
  const ctx = { bb, db, configForRun: async () => ({ hostId: "local" }), host: {
    call: async (method: string, args: { command: string; cwd: string }) => {
      expect(method).toBe("runCommand");
      calls++;
      commandCwds.push(args.cwd);
      if (response === "none") return { exitCode: 0, stdout: "none" };
      if (response === "fail-none") return { exitCode: 1, stdout: "none" };
      if (fail) return { exitCode: 1, stdout: "", stderr: "git commit refused" };
      return { exitCode: 0, stdout: execFileSync("sh", ["-c", args.command], { cwd: args.cwd, encoding: "utf8" }) };
    },
  }, acceptedTaskWorkspace: (_runId: string, _taskId: string, _runWorkspacePath: string, contract: { project_cwd: string }) => ({
    path: contract.project_cwd,
    environmentId: null,
    task: { ...contract },
  }) } as unknown as ServerCore;
  const services = { stageHelperSettings, projectLifeTaskSummary: () => ({ id: receipt.taskId, title: "Muse session sync", objective: "Sync session", acceptanceSummary: "" }) } as unknown as Services;
  const { runProjectLifeMaintenance } = createProjectLifeStage(ctx, services);
  const run = () => runProjectLifeMaintenance({ threadId: pmThreadId, projectId, runId: receipt.runId, taskId: receipt.taskId });
  return { db, dir, runPath, acceptedWorktree, run, git, calls: () => calls, commandCwds: () => commandCwds };
}

describe("project-life script closes its receipt", () => {
  for (const prior of ["missing", "pending", "running"] as const) {
    it.each([false, true])(`finishes from ${prior} (command fails: %s), and a repeat does no work`, async (fail) => {
      const w = setup(fail, prior);
      try {
        const result = await w.run();
        expect(result.state).toBe(fail ? "failed" : "passed");
        expect(listStageReceipts(w.db, receipt.runId, receipt.taskId).find((row) => row.stageId === "project-life"))
          .toMatchObject({ state: result.state, providerId: "script", ...(fail ? { reason: "changelog_commit_failed:git commit refused" } : { result: { coveredTaskIds: [receipt.taskId], commit: w.git("rev-parse", "HEAD") } }) });
        if (!fail) expect(readFileSync(join(w.dir, ".agents/CHANGELOG.md"), "utf8")).toContain(receipt.taskId);
        expect((await w.run()).state).toBe(result.state);
        expect(w.calls()).toBe(1);
      } finally { w.db.close(); }
    });
  }
});

describe("project-life script uses the accepted workspace", () => {
  it("writes repo-scope memory at the repository root after the accepted section worktree is gone", async () => {
    const w = setup(false, "missing", "repo-root");
    try {
      expect((await w.run()).state).toBe("passed");
      expect(w.commandCwds()).toEqual([w.dir]);
      expect(readFileSync(join(w.dir, ".agents/CHANGELOG.md"), "utf8")).toContain(receipt.taskId);
      expect(existsSync(join(w.runPath, ".agents/CHANGELOG.md"))).toBe(false);
      expect(w.acceptedWorktree && existsSync(w.acceptedWorktree)).toBe(false);
    } finally { w.db.close(); }
  });

  it("keeps a normal section task's memory in the section checkout", async () => {
    const w = setup(false, "missing", "normal-section");
    try {
      expect((await w.run()).state).toBe("passed");
      expect(w.commandCwds()).toEqual([w.runPath]);
      expect(readFileSync(join(w.runPath, ".agents/CHANGELOG.md"), "utf8")).toContain(receipt.taskId);
      expect(existsSync(join(w.dir, ".agents/CHANGELOG.md"))).toBe(false);
    } finally { w.db.close(); }
  });
});

describe("project-life script sentinel responses", () => {
  it("keeps numeric zero with the none sentinel as a passed receipt with a null commit", async () => {
    const w = setup(false, "missing", "run-root", "none");
    try {
      const result = await w.run();
      expect(result.state).toBe("passed");
      expect(result.result).toMatchObject({ commit: null, coveredTaskIds: [receipt.taskId] });
    } finally { w.db.close(); }
  });

  it("keeps a nonzero exit with the none sentinel as a failed receipt", async () => {
    const w = setup(false, "missing", "run-root", "fail-none");
    try {
      const result = await w.run();
      expect(result.state).toBe("failed");
      expect(result.reason).toBe("changelog_commit_failed:none");
    } finally { w.db.close(); }
  });
});
