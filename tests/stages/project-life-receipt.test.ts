import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { validateStageReceipt } from "@lane-pilot/contracts";
import { describe, expect, it } from "vitest";
import { createProjectLifeStage } from "../../src/rooms/project-life/server/project-life";
import { createRun, createTask, listStageReceipts, openDatabase, saveStageReceipt, setRunThread, setRunWorkspace } from "../../src/rooms/plugin-db";
import { recordStage } from "../../src/rooms/runs/server/stage-records";
import type { ServerCore, Services } from "../../src/rooms/core/server";
import receipt from "../fixtures/stage-left-open/muse-session-sync.json";

// Hub list_run_stages, 2026-11-03: accepted task, pending project-life, no child or result.
// Only the workspace and the task's unrelated product contract are replaced for local replay.
function setup(fail: boolean, prior: "missing" | "pending" | "running") {
  const dir = mkdtempSync(join(tmpdir(), "lp-life-receipt-"));
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
  createRun(db, receipt.runId, projectId, "bb", dir);
  setRunThread(db, receipt.runId, pmThreadId);
  setRunWorkspace(db, receipt.runId, dir, "local-env");
  createTask(db, { id: receipt.taskId, runId: receipt.runId, kind: "bb", contract: {
    schema_version: 2, id: receipt.taskId, title: "Muse session sync", objective: "Sync session",
    risk: "low", lane: "writer", project_cwd: dir, read_first: ["README.md"], interfaces: [], invariants: [],
    out_of_scope: [], expected_outputs: ["session.ts"], owns_paths: ["session.ts"], never_touch: [],
    depends_on: [], acceptance: ["Session sync works"], verify: "none", verification: [],
  } });
  recordStage(db, { runId: receipt.runId, taskId: receipt.taskId, stageId: "acceptance-receipt", state: "passed", input: "accepted" });
  if (prior !== "missing") saveStageReceipt(db, validateStageReceipt({ ...receipt, state: prior }));
  let calls = 0;
  const ctx = { bb, db, configForRun: async () => ({ hostId: "local" }), host: {
    call: async (method: string, args: { command: string }) => {
      expect(method).toBe("runCommand");
      calls++;
      if (fail) return { exitCode: 1, stdout: "", stderr: "git commit refused" };
      return { exitCode: 0, stdout: execFileSync("sh", ["-c", args.command], { cwd: dir, encoding: "utf8" }) };
    },
  } } as unknown as ServerCore;
  const services = { projectLifeTaskSummary: () => ({ id: receipt.taskId, title: "Muse session sync", objective: "Sync session", acceptanceSummary: "" }) } as unknown as Services;
  const { runProjectLifeMaintenance } = createProjectLifeStage(ctx, services);
  const run = () => runProjectLifeMaintenance({ threadId: pmThreadId, projectId, runId: receipt.runId, taskId: receipt.taskId });
  return { db, dir, run, git, calls: () => calls };
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
