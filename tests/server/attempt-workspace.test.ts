import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createAttempt, createRun, createTask, openDatabase, setAttemptWorkspace, transitionAttempt } from "../../src/database";
import { createCore } from "../../src/server/core";

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
    transitionAttempt(db, "lpattempt_a", "running", { threadId: "thr_writer" });
    // Resumed after a reload: the writer is still at work in its own worktree.
    expect(core.acceptedTaskWorkspace("run", "bot-fix", base, task, "lpattempt_a").path).toBe(worktree);
    transitionAttempt(db, "lpattempt_a", "validation_failed", { reason: "x" });
    // Finished: the worktree is gone, a retry starts from the base checkout.
    expect(core.acceptedTaskWorkspace("run", "bot-fix", base, task, "lpattempt_a").path).toBe(base);
    expect(core.acceptedTaskWorkspace("run", "bot-fix", base, task).path).toBe(base);
    await harness.lifecycle.dispose();
  });
});
