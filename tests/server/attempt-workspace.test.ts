import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createAttempt, createRun, createTask, openDatabase, setAttemptWorkspace, transitionAttempt } from "../../src/database";
import { createCore } from "../../src/server/core";
import { freshAttemptStart } from "../../src/server/writer/start";

const base = "/home/ubuntu/apps/selfystudio";
const worktree = "/home/ubuntu/.lane-pilot/worktrees/lpattempt_a/selfystudio";
const task = {
  schema: "lane-stack.task.v2", id: "bot-fix", title: "Bot fix", objective: "Fix", risk: "low", project_cwd: base,
  owns_paths: ["apps/bot/**"], read_first: [], expected_outputs: ["apps/bot/x.ts"], verify: "none", verification: [],
} as never;

describe("attempt workspace for a native run's own worktree", () => {
  it("keeps a running attempt in its worktree and sends finished ones back to the base checkout", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const core = createCore(bb, db);
    createRun(db, "run", "P", "cli", base);
    createTask(db, { id: "bot-fix", runId: "run", kind: "bb", contract: task });
    createAttempt(db, { id: "lpattempt_a", runId: "run", taskId: "bot-fix" });
    expect(setAttemptWorkspace(db, "lpattempt_a", { path: worktree, environmentId: null, decision: {} })).toBe(true);
    transitionAttempt(db, "lpattempt_a", "spawn_requested");
    transitionAttempt(db, "lpattempt_a", "running", { threadId: "thr_writer" });
    // Resumed after a reload: the writer is still at work in its own worktree.
    expect(core.acceptedTaskWorkspace("run", "bot-fix", base, task, "lpattempt_a").path).toBe(worktree);
    transitionAttempt(db, "lpattempt_a", "validation_failed", { reason: "x" });
    // Finished: the worktree is gone, a retry starts from the base checkout.
    expect(core.acceptedTaskWorkspace("run", "bot-fix", base, task, "lpattempt_a").path).toBe(base);
    expect(core.acceptedTaskWorkspace("run", "bot-fix", base, task).path).toBe(base);
    await harness.lifecycle.dispose();
  });

  it("does the same for a dispatched run: its writers have their own worktrees too", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const core = createCore(bb, db);
    createRun(db, "run-bb", "P", "bb", base);
    createTask(db, { id: "bot-fix", runId: "run-bb", kind: "bb", contract: task });
    createAttempt(db, { id: "lpattempt_d", runId: "run-bb", taskId: "bot-fix" });
    expect(setAttemptWorkspace(db, "lpattempt_d", { path: worktree, environmentId: null, decision: {} })).toBe(true);
    transitionAttempt(db, "lpattempt_d", "spawn_requested");
    transitionAttempt(db, "lpattempt_d", "running", { threadId: "thr_writer" });
    expect(core.acceptedTaskWorkspace("run-bb", "bot-fix", base, task, "lpattempt_d").path).toBe(worktree);
    transitionAttempt(db, "lpattempt_d", "validation_failed", { reason: "x" });
    expect(core.acceptedTaskWorkspace("run-bb", "bot-fix", base, task, "lpattempt_d").path).toBe(base);
    await harness.lifecycle.dispose();
  });

  it("a retry of an attempt resumed in its worktree starts from the run's workspace, not the removed worktree", () => {
    const resumed = { ...(task as object), project_cwd: worktree, verification: [{ command: "npm test", cwd: worktree }] } as never;
    const config = { hostId: "h", writerWorkspacePath: worktree } as never;
    const fresh = freshAttemptStart(resumed, config, base);
    expect(fresh.task.project_cwd).toBe(base);
    expect(fresh.task.verification[0]!.cwd).toBe(base);
    expect(fresh.config.writerWorkspacePath).toBe(base);
    const plain = { ...(task as object) } as never;
    expect(freshAttemptStart(plain, config, base).task).toBe(plain);
  });
});

describe("stages after acceptance", () => {
  it("run in the run workspace once an attempt's BB worktree is merged, even while that worktree stays for the area", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const core = createCore(bb, db);
    createRun(db, "run", "P", "bb", base);
    createTask(db, { id: "bot-fix", runId: "run", kind: "bb", contract: task });
    createAttempt(db, { id: "lpattempt_b", runId: "run", taskId: "bot-fix" });
    setAttemptWorkspace(db, "lpattempt_b", { path: "/bb/env_b/selfystudio", environmentId: "env_b", decision: {} });
    transitionAttempt(db, "lpattempt_b", "spawn_requested");
    transitionAttempt(db, "lpattempt_b", "running", { threadId: "thr_writer" });
    expect(core.acceptedTaskWorkspace("run", "bot-fix", base, task, "lpattempt_b")).toMatchObject({ path: "/bb/env_b/selfystudio", environmentId: "env_b" });
    transitionAttempt(db, "lpattempt_b", "accepted");
    expect(core.acceptedTaskWorkspace("run", "bot-fix", base, task)).toMatchObject({ path: base, environmentId: null });
    await harness.lifecycle.dispose();
  });
});
