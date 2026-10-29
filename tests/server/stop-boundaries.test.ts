import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import { cancelAttemptById } from "../../src/rooms/runs/server/cancel";
import { createRollback } from "../../src/rooms/rollback/server/rollback";
import { createReconcile } from "../../src/rooms/stability/server/reconcile";
import { createAttempt, createRun, createTask, getAttempt, openDatabase, transitionAttempt } from "../../src/rooms/storage/database";

// The 2026-10-29 full-code audit (Аудит GPT), probes A-004, A-005 and A-006, kept as regressions.
function runningAttempt(bb: Parameters<typeof openDatabase>[0]) {
  const db = openDatabase(bb);
  createRun(db, "run", "project"); createTask(db, { id: "task", runId: "run", kind: "bb", contract: {} }); createAttempt(db, { id: "a", runId: "run", taskId: "task" });
  transitionAttempt(db, "a", "spawn_requested"); transitionAttempt(db, "a", "running", { threadId: "writer" });
  return db;
}

describe("a stop and its two conditions", () => {
  it("does not report a stop complete when the writer's worktree could not be put on record, and asks git twice", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: { stop: async () => {}, get: async () => ({ id: "writer", status: "idle" }), listRunning: async () => [] } } as never });
    const db = runningAttempt(bb);
    db.prepare("UPDATE lane_pilot_run SET writer_host_id='h',writer_workspace_path='/repo' WHERE id='run'").run();
    db.prepare("UPDATE lane_pilot_attempt SET workspace_path='/repo/writer' WHERE id='a'").run();
    let snapshots = 0;
    const { rollback } = createRollback({ db, log: () => {}, host: { call: async () => { snapshots++; throw new Error("snapshot unavailable"); } } } as never, {} as never);
    try {
      const result = await cancelAttemptById({ bb, db } as never, "a", rollback);
      expect(result).toMatchObject({ ok: false, state: "canceled" });
      expect(result.reason).toContain("snapshot unavailable");
      expect(snapshots).toBe(2);
      expect(getAttempt(db, "a")?.state).toBe("canceled");
    } finally { await harness.lifecycle.dispose(); }
  });

  it("starts no host job for a call aborted before it started", async () => {
    const calls: string[] = [];
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", experimental_callHostRpc: (call) => { calls.push(call.method); if (call.method === "jobStart") return { hostId: "h", jobId: "job_abcdefghijk" }; throw new Error(`unexpected ${call.method}`); } });
    const ctx = createCore(bb, openDatabase(bb));
    try {
      await expect(ctx.host.call("gitIntegrate", { requestedHostId: "h", basePath: "/fixture/base", worktreePath: "/fixture/writer" } as never,
        { hostId: "h", signal: AbortSignal.abort(new Error("run canceled")) } as never)).rejects.toThrow("run canceled");
      expect(calls).not.toContain("jobStart");
    } finally { await harness.lifecycle.dispose(); }
  });

  it("finishes a cancel a reload cut off: the writer is stopped again and the attempt ends canceled once it is idle", async () => {
    let stops = 0, looks = 0;
    const triple = { lanePilotRunId: "run", lanePilotTaskId: "task", attemptId: "a" };
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: {
      get: async () => ({ id: "writer", status: ++looks > 3 ? "idle" : "active" }), list: async () => [{ id: "writer" }], listRunning: async () => [],
      getPluginMetadata: async () => triple, stop: async () => { stops++; } } } as never });
    const db = runningAttempt(bb);
    transitionAttempt(db, "a", "cancel_requested");
    const api = createReconcile({ bb, db, isDisposed: () => false, refreshRun: () => {}, log: () => {} } as never, { startWriterTask: () => { throw new Error("a canceling writer is not started again"); } } as never);
    try {
      await api.resumeOrphans();
      expect(stops).toBe(1);
      await vi.waitFor(() => expect(getAttempt(db, "a")?.state).toBe("canceled"), { timeout: 10_000, interval: 100 });
    } finally { await harness.lifecycle.dispose(); }
  });

  it("does not count a failed read of the worktree as its record", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: { stop: async () => {}, get: async () => ({ id: "writer", status: "idle" }), listRunning: async () => [] } } as never });
    const db = runningAttempt(bb);
    db.prepare("UPDATE lane_pilot_run SET writer_host_id='h',writer_workspace_path='/repo' WHERE id='run'").run();
    db.prepare("UPDATE lane_pilot_attempt SET workspace_path='/repo/writer' WHERE id='a'").run();
    const { rollback } = createRollback({ db, log: () => {}, host: { call: async () => ({ hostId: "h", status: "failed", head: null, base: null, dirty: 0, ahead: 0, changed: [], reason: "git status failed" }) } } as never, {} as never);
    try {
      const result = await cancelAttemptById({ bb, db } as never, "a", rollback);
      expect(result).toMatchObject({ ok: false, state: "canceled" });
      expect(result.reason).toContain("git status failed");
    } finally { await harness.lifecycle.dispose(); }
  });

  it("records the worktree when recovery finds the canceled writer already idle", async () => {
    let records = 0;
    const triple = { lanePilotRunId: "run", lanePilotTaskId: "task", attemptId: "a" };
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: {
      get: async () => ({ id: "writer", status: "idle" }), list: async () => [{ id: "writer" }], listRunning: async () => [], getPluginMetadata: async () => triple, stop: async () => {} } } as never });
    const db = runningAttempt(bb);
    transitionAttempt(db, "a", "cancel_requested");
    const api = createReconcile({ bb, db, isDisposed: () => false, refreshRun: () => {}, log: () => {} } as never,
      { startWriterTask: () => {}, rollback: { noteStopped: async () => { records++; return { recorded: true }; } } } as never);
    try {
      await api.resumeOrphans();
      expect(getAttempt(db, "a")?.state).toBe("canceled");
      expect(records).toBe(1);
    } finally { await harness.lifecycle.dispose(); }
  });
});
