import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { LP_EVENTS } from "@lane-pilot/contracts";
import { WorkflowEngine } from "@lane-pilot/workflow-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { taskV2Schema } from "../src/rooms/contracts";
import {
  createAttempt,
  createRun,
  createTask,
  getAttempt,
  openDatabase,
  saveTaskPlan,
  transitionAttempt,
} from "../src/rooms/plugin-db";
import { createReconcile } from "../src/rooms/stability/server";
import { createTaskReconcile } from "../src/rooms/runs/server";
import { registerLandingSuiteAction, verifyProofReceiptsCurrent, hostGit } from "../src/rooms/verification/server";
import { createWorkflowTriggers } from "../src/rooms/workflow/server/services/workflow-triggers";
import { builtinWorkflow, builtinWorkflows } from "../src/rooms/workflow/builtin";
import { createWriterFinish } from "../src/rooms/writer/server/services/finish";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

describe("Task 14 run and attempt lifecycle events", () => {
  it("kill between attempt spawn and first event -> startup reconcile finds it with no duplicate spawns", async () => {
    const startWriterCalls: Array<{ firstAttemptId: string; writerThreadId?: string; turnSent?: boolean }> = [];
    const createdThreads: string[] = [];
    const metadataByThread = new Map<string, Record<string, unknown>>([
      ["thr_orphaned_spawn", { role: "writer", lanePilotRunId: "run-1", lanePilotTaskId: "t1", attemptId: "att-1" }],
    ]);
    const { bb } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          list: async () => [{ id: "thr_orphaned_spawn" }],
          getPluginMetadata: async ({ threadId }: { threadId: string }) => metadataByThread.get(threadId) ?? {},
          get: async ({ threadId }: { threadId: string }) => ({ id: threadId, projectId: "proj-1", status: "active" }),
          create: async () => {
            const id = `thr_dup_${createdThreads.length + 1}`;
            createdThreads.push(id);
            return { id };
          },
          send: async () => ({}),
        },
      } as never,
    });
    const db = openDatabase(bb);
    const task = taskV2Schema.parse({
      schema_version: 2,
      id: "t1",
      title: "Fix module",
      risk: "medium",
      lane: "writer",
      project_cwd: "/repo",
      read_first: [],
      interfaces: [],
      invariants: [],
      out_of_scope: [],
      expected_outputs: ["src/a.ts"],
      owns_paths: ["src"],
      never_touch: [],
      depends_on: [],
      objective: "Fix module",
      acceptance: ["src/a.ts fixed"],
      verify: "none",
      verification: [],
    });
    createRun(db, "run-1", "proj-1", "cli", "/repo");
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id='pm-1' WHERE id='run-1'").run();
    createTask(db, { id: "t1", runId: "run-1", kind: "bb", contract: task });
    saveTaskPlan(db, "t1", "Fix module");
    createAttempt(db, { id: "att-1", runId: "run-1", taskId: "t1" });
    // Killed right after BB created the thread during spawn_requested, before thread_id or first event was saved:
    transitionAttempt(db, "att-1", "spawn_requested");

    const services: Record<string, unknown> = {
      activeWriterTasks: new Set<string>(),
      startWriterTask: (input: { firstAttemptId: string; writerThreadId?: string; turnSent?: boolean }) => {
        startWriterCalls.push(input);
        services.activeWriterTasks = new Set(["run-1:t1"]);
      },
      recoverMergeIntents: async () => undefined,
      recheckCancels: async () => [],
      stability: {
        reconcileScanOpen: () => false,
        adoptBlockedByFaults: async () => undefined,
        sweep: async () => undefined,
      },
      startAfterAcceptance: () => undefined,
    };
    const ctx = {
      bb,
      db,
      log: () => undefined,
      isDisposed: () => false,
      refreshRun: () => undefined,
      configForRun: async () => ({ hostId: "h1", writerWorkspacePath: "/repo" }),
      acceptedTaskWorkspace: (_r: string, _t: string, ws: string, contract: unknown) => ({ path: ws, task: contract }),
    } as never;

    const { resumeOrphans } = createReconcile(ctx, services as never);
    services.resumeOrphans = resumeOrphans;
    const taskReconcile = createTaskReconcile(ctx, services as never);

    await taskReconcile.reconcile(db, Date.now());
    expect(getAttempt(db, "att-1")?.state).toBe("running");
    expect(getAttempt(db, "att-1")?.thread_id).toBe("thr_orphaned_spawn");
    expect(startWriterCalls).toHaveLength(1);
    expect(startWriterCalls[0]).toMatchObject({
      firstAttemptId: "att-1",
      writerThreadId: "thr_orphaned_spawn",
      turnSent: true,
    });
    expect(createdThreads).toEqual([]);
    // No duplicate attempts created in SQLite:
    expect((db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_attempt WHERE task_id='t1'").get() as { n: number }).n).toBe(1);
  });

  it("a merge fires the unified landing step once per attempt", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const task = taskV2Schema.parse({
      schema_version: 2,
      id: "landing-task",
      title: "Ship feature",
      risk: "medium",
      lane: "writer",
      project_cwd: "/repo/wt",
      read_first: [],
      interfaces: [],
      invariants: [],
      out_of_scope: [],
      expected_outputs: ["src/feat.ts"],
      owns_paths: ["src"],
      never_touch: [],
      depends_on: [],
      objective: "Ship feature",
      acceptance: ["tests pass"],
      verify: "tests",
      verification: [{ command: "npx vitest run", cwd: "/repo/wt" }],
    });
    createRun(db, "run-merge", "proj-m", "cli", "/repo/base");
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id='pm-m' WHERE id='run-merge'").run();
    createTask(db, { id: "landing-task", runId: "run-merge", kind: "bb", contract: task });
    createAttempt(db, { id: "att-merge-1", runId: "run-merge", taskId: "landing-task" });

    const runVerification = vi.fn(async () => [{ command: "npx vitest run", exitCode: 0, stdout: "1 passed", stderr: "" }]);
    const dispatchWriter = vi.fn(async () => ({ state: "queued" }));
    const engine = new WorkflowEngine({ db, harnessVersion: "test", resolveWorkflow: builtinWorkflow });
    const ctx = {
      bb,
      db,
      log: () => undefined,
      state: { disposed: false },
      isDisposed: () => false,
      host: { call: async () => ({ exitCode: 1, stdout: "", stderr: "" }) },
      configForRun: async () => ({ hostId: "h1", writerWorkspacePath: "/repo/base" }),
    } as never;

    registerLandingSuiteAction(engine, ctx, { runVerification: runVerification as never, dispatchWriter: dispatchWriter as never });

    const triggers = createWorkflowTriggers(
      ctx,
      {
        workflowEngine: engine,
        schedules: { save: async () => ({ ok: true, schedule: { id: "s1" } }) } as never,
        dispatchWriter: dispatchWriter as never,
      } as never,
      {
        loadStore: async () => ({
          project: "ok" as const,
          store: {
            list: () => builtinWorkflows().map((workflow) => ({ workflow })),
            get: (id: string) => {
              const wf = builtinWorkflow(id);
              return wf ? { workflow: wf } : null;
            },
          } as never,
        }),
        scheduleBoard: { save: async () => ({ ok: true, schedule: { id: "s1" } as never }), remove: () => true },
      },
    );

    const finish = createWriterFinish(ctx, { runVerification, dispatchWriter, workflowTriggers: triggers } as never);
    const landedInput = {
      projectId: "proj-m",
      runId: "run-merge",
      taskId: "landing-task",
      attemptId: "att-merge-1",
      writerThreadId: "thr-w1",
      pmThreadId: "pm-m",
      config: { hostId: "h1" } as never,
      task,
    };

    // Call landed twice for the same attempt merge:
    finish.landed(landedInput, "/repo/base", "commit-111", ["src/feat.ts"], false, "/repo/wt", ["npx vitest run"]);
    finish.landed(landedInput, "/repo/base", "commit-111", ["src/feat.ts"], false, "/repo/wt", ["npx vitest run"]);
    await new Promise((r) => setTimeout(r, 80));

    expect(runVerification).toHaveBeenCalledTimes(1);
    expect(dispatchWriter).not.toHaveBeenCalled();
    const inboxCount = (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_wf_inbox WHERE name=?").get(LP_EVENTS.ATTEMPT_MERGED) as { n: number }).n;
    expect(inboxCount).toBe(1);
  });

  it("a merge still fires the landing step when project workflow files / loop hooks are unavailable", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const task = taskV2Schema.parse({
      schema_version: 2,
      id: "landing-task-unavail",
      title: "Ship feature",
      risk: "medium",
      lane: "writer",
      project_cwd: "/repo/wt",
      read_first: [],
      interfaces: [],
      invariants: [],
      out_of_scope: [],
      expected_outputs: ["src/feat.ts"],
      owns_paths: ["src"],
      never_touch: [],
      depends_on: [],
      objective: "Ship feature",
      acceptance: ["tests pass"],
      verify: "tests",
      verification: [{ command: "npx vitest run", cwd: "/repo/wt" }],
    });
    createRun(db, "run-merge-unavail", "proj-u", "cli", "/repo/base");
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id='pm-u' WHERE id='run-merge-unavail'").run();
    createTask(db, { id: "landing-task-unavail", runId: "run-merge-unavail", kind: "bb", contract: task });
    createAttempt(db, { id: "att-merge-unavail", runId: "run-merge-unavail", taskId: "landing-task-unavail" });

    const runVerification = vi.fn(async () => [{ command: "npx vitest run", exitCode: 0, stdout: "1 passed", stderr: "" }]);
    const dispatchWriter = vi.fn(async () => ({ state: "queued" }));
    const engine = new WorkflowEngine({ db, harnessVersion: "test", resolveWorkflow: builtinWorkflow });
    const ctx = {
      bb,
      db,
      log: () => undefined,
      state: { disposed: false },
      isDisposed: () => false,
      host: { call: async () => ({ exitCode: 1, stdout: "", stderr: "" }) },
      configForRun: async () => ({ hostId: "h1", writerWorkspacePath: "/repo/base" }),
    } as never;

    registerLandingSuiteAction(engine, ctx, { runVerification: runVerification as never, dispatchWriter: dispatchWriter as never });

    const triggers = createWorkflowTriggers(
      ctx,
      { workflowEngine: engine, dispatchWriter: dispatchWriter as never } as never,
      {
        loadStore: async () => ({
          project: "unavailable" as const,
          loopHooks: {
            manifest: null,
            sha256: null,
            error: "project workflow files are unavailable; loop hooks cannot be safely resolved",
          },
          store: {
            list: () => builtinWorkflows().map((workflow) => ({ workflow })),
            get: (id: string) => {
              const wf = builtinWorkflow(id);
              return wf ? { workflow: wf } : null;
            },
            resolve: builtinWorkflow,
          } as never,
        }),
      },
    );

    const finish = createWriterFinish(ctx, { runVerification, dispatchWriter, workflowTriggers: triggers } as never);
    finish.landed(
      {
        projectId: "proj-u",
        runId: "run-merge-unavail",
        taskId: "landing-task-unavail",
        attemptId: "att-merge-unavail",
        writerThreadId: "thr-w1",
        pmThreadId: "pm-u",
        config: { hostId: "h1" } as never,
        task,
      },
      "/repo/base",
      "commit-222",
      ["src/feat.ts"],
      false,
      "/repo/wt",
      ["npx vitest run"],
    );

    await vi.waitFor(() => expect(runVerification).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    expect(dispatchWriter).not.toHaveBeenCalled();
  });

  it("does not count stale or non-ancestor receipts as proof via proofCurrency()", async () => {
    const repo = mkdtempSync(join(tmpdir(), "lp-stale-proof-"));
    tempDirs.push(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src/feature.ts"), "export const v = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "v1");
    const c1 = git(repo, "rev-parse", "HEAD");

    // Side branch commit not on main:
    git(repo, "checkout", "-qb", "side");
    writeFileSync(join(repo, "src/side.ts"), "export const side = true;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "side");
    const sideCommit = git(repo, "rev-parse", "HEAD");

    // Back to main and modify src/feature.ts so receipt at c1 becomes stale:
    git(repo, "checkout", "-q", "main");
    writeFileSync(join(repo, "src/feature.ts"), "export const v = 2;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "v2 modifies feature");
    const c2 = git(repo, "rev-parse", "HEAD");

    const localGit = hostGit(async (command) => {
      try {
        const stdout = execFileSync("/bin/sh", ["-lc", command], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }).toString();
        return { exitCode: 0, stdout, stderr: "" };
      } catch (err) {
        const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
        return { exitCode: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
      }
    });

    const staleCheck = await verifyProofReceiptsCurrent({
      receipts: [{ id: "rcpt-old", commit: c1, paths: ["src/feature.ts"] }],
      git: localGit,
    });
    expect(staleCheck.current).toBe(false);
    expect(staleCheck.staleIds).toEqual(["rcpt-old"]);
    expect(staleCheck.verdicts[0]?.verdict).toBe("stale");

    const branchCheck = await verifyProofReceiptsCurrent({
      receipts: [{ id: "rcpt-side", commit: sideCommit, paths: ["src/side.ts"] }],
      git: localGit,
    });
    expect(branchCheck.current).toBe(false);
    expect(branchCheck.staleIds).toEqual(["rcpt-side"]);
    expect(branchCheck.verdicts[0]?.verdict).toBe("not_on_history");

    const freshCheck = await verifyProofReceiptsCurrent({
      receipts: [{ id: "rcpt-head", commit: c2, paths: ["src/feature.ts"] }],
      git: localGit,
    });
    expect(freshCheck.current).toBe(true);
    expect(freshCheck.staleIds).toEqual([]);
    expect(freshCheck.verdicts[0]?.verdict).toBe("current");
  });
});
