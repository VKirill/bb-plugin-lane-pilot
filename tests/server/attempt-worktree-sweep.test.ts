import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { createAttempt, createRun, openDatabase } from "../../src/rooms/storage/database";
import { cleanupFinishedAttemptEnvironments } from "../../src/server/run-finish";

async function sweep(snapshotStatus: "clean" | "saved" | "failed" = "clean", failure = "disk") {
  const deleted: string[] = [], snapshots: string[] = [];
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot", sdk:{
    environments:{
      get:async ({ environmentId }: { environmentId:string }) => ({ id:environmentId, hostId:"ovh", path:`/wt/${environmentId}`, lifecycle:{ phase:"active" } }),
      archiveThreads:async () => undefined,
      delete:async ({ environmentId }: { environmentId:string }) => { deleted.push(environmentId); },
    },
    threads:{ get:async ({ threadId }: { threadId:string }) => ({ id:threadId, environmentId:`env_of_${threadId}` }) },
  } as never });
  const warns: string[] = [];
  vi.spyOn(bb.log, "warn").mockImplementation((message: string) => { warns.push(message); });
  const db = openDatabase(bb);
  createRun(db, "run", "proj", "cli", "/repo");
  const now = 10_000_000;
  let order = 0;
  const attempt = (id:string, task:string, env:string|null, state:string, age:number, holder:string|null = null) => {
    createAttempt(db, { id, runId:"run", taskId:task });
    db.prepare("UPDATE lane_pilot_attempt SET environment_id=?, holder_thread_id=?, state=?, updated_at=?, created_at=? WHERE id=?").run(env, holder, state, now - age, ++order, id);
  };
  attempt("a", "t-done", "env_done", "accepted", 3_600_000);
  attempt("b", "t-recent", "env_recent", "accepted", 60_000);
  attempt("c", "t-live", "env_live", "running", 3_600_000);
  // Failed, then retried: the failed attempt's worktree is free once the retry exists.
  attempt("d1", "t-retry", "env_replaced", "validation_failed", 3_600_000);
  attempt("d2", "t-retry", "env_retry", "running", 3_600_000);
  // Failed with nothing after it: kept, the task may still be retried or looked at.
  attempt("e", "t-alone", "env_alone", "empty_output", 3_600_000);
  // A holder worktree never bound to its (blocked) attempt.
  attempt("f", "t-holder", null, "blocked", 3_600_000, "thr_holder");
  const removed = await cleanupFinishedAttemptEnvironments(bb, db, async (_host, path, name) => {
    snapshots.push(`${name}:${path}`);
    return { status:snapshotStatus, path:snapshotStatus === "saved" ? `/released/${name}.patch` : null, reason:snapshotStatus === "failed" ? failure : null };
  }, now);
  return { removed:removed.sort(), deleted:deleted.sort(), snapshots, warns };
}

it("releases finished, replaced and unbound-holder worktrees; keeps live, recent and unreplaced failures", async () => {
  const { removed, snapshots } = await sweep("saved");
  expect(removed).toEqual(["env_done", "env_of_thr_holder", "env_replaced"]);
  expect(snapshots).toContain("env_replaced:/wt/env_replaced");
});

it("keeps every worktree whose changes could not be saved", async () => {
  const { removed, deleted } = await sweep("failed");
  expect(removed).toEqual([]);
  expect(deleted).toEqual([]);
});

// A reload disposes this instance while its sweep waits on a host call; the next calls all fail with a stale handle or a
// retired host generation. That is no lost save: the new instance sweeps the same worktrees (hub, 2026-10-04).
it.each([
  'plugin "lane-pilot" used a stale API handle — it was reloaded or disabled; re-entry happens via a fresh factory call',
  "host plugin lane-pilot generation c7de82a9-b1ff-4676-a3f1-20bb08139816 is retired",
])("stops quietly when a reload ends the plugin mid-sweep (%s)", async (failure) => {
  const { removed, deleted, snapshots, warns } = await sweep("failed", failure);
  expect(removed).toEqual([]);
  expect(deleted).toEqual([]);
  expect(snapshots).toHaveLength(1);
  expect(warns).toEqual([]);
});

it("keeps an area's last accepted worktree for the sticky window, then releases it", async () => {
  const { createTask } = await import("../../src/rooms/storage/database");
  const { STICKY_WINDOW_MS } = await import("../../src/server/writer/sticky");
  const deleted: string[] = [];
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot", sdk:{
    environments:{
      get:async ({ environmentId }: { environmentId:string }) => ({ id:environmentId, hostId:"ovh", path:`/wt/${environmentId}`, lifecycle:{ phase:"active" } }),
      archiveThreads:async () => undefined,
      delete:async ({ environmentId }: { environmentId:string }) => { deleted.push(environmentId); },
    },
  } as never });
  const db = openDatabase(bb);
  createRun(db, "run", "proj", "bb", "/repo");
  createTask(db, { id:"page-task", runId:"run", kind:"bb", contract:{ area:"page:/cards" } });
  createTask(db, { id:"plain-task", runId:"run", kind:"bb", contract:{} });
  const now = 100_000_000;
  for (const [id, task, env] of [["a", "page-task", "env_area"], ["b", "plain-task", "env_plain"]] as const) {
    createAttempt(db, { id, runId:"run", taskId:task });
    db.prepare("UPDATE lane_pilot_attempt SET environment_id=?, state='accepted', updated_at=? WHERE id=?").run(env, now - 3_600_000, id);
  }
  const clean = async () => "clean" as const;
  const snapshot = async () => ({ status:await clean(), path:null, reason:null });
  expect(await cleanupFinishedAttemptEnvironments(bb, db, snapshot, now)).toEqual(["env_plain"]);
  // The fake host keeps listing a deleted environment; only the area one matters here.
  expect(await cleanupFinishedAttemptEnvironments(bb, db, snapshot, now + STICKY_WINDOW_MS)).toContain("env_area");
});

it("removes Lane Pilot's own area worktrees after the sticky window, once, and never while an attempt works there", async () => {
  const { createTask } = await import("../../src/rooms/storage/database");
  const { STICKY_WINDOW_MS } = await import("../../src/server/writer/sticky");
  const { cleanupStickyLaneWorktrees } = await import("../../src/server/run-finish");
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "proj", "bb", "/repo", "none", undefined, "ovh");
  createTask(db, { id:"page-task", runId:"run", kind:"bb", contract:{ area:"page:/cards" } });
  createTask(db, { id:"busy-task", runId:"run", kind:"bb", contract:{ area:"page:/faq" } });
  const now = 100_000_000;
  const at = (id:string, task:string, path:string, state:string) => {
    createAttempt(db, { id, runId:"run", taskId:task });
    db.prepare("UPDATE lane_pilot_attempt SET workspace_path=?, state=?, updated_at=? WHERE id=?").run(path, state, now - 60_000, id);
  };
  at("a", "page-task", "/lp/wt/a", "accepted");
  at("b", "busy-task", "/lp/wt/b", "running");
  const calls: string[] = [];
  const remove = async (host:string, base:string, path:string) => { calls.push(`${host}:${base}:${path}`); return true; };
  const released = new Set<string>();
  expect(await cleanupStickyLaneWorktrees(db, remove, released, now)).toEqual([]);
  expect(await cleanupStickyLaneWorktrees(db, remove, released, now + STICKY_WINDOW_MS)).toEqual(["/lp/wt/a"]);
  expect(await cleanupStickyLaneWorktrees(db, remove, released, now + STICKY_WINDOW_MS)).toEqual([]);
  expect(calls).toEqual(["ovh:/repo:/lp/wt/a"]);
});

it("removes the worktree of a task without an area once its attempts are over for 30 minutes, and never while one is open or could still be redone", async () => {
  const { createTask } = await import("../../src/rooms/storage/database");
  const { cleanupStickyLaneWorktrees } = await import("../../src/server/run-finish");
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "proj", "bb", "/repo", "none", undefined, "ovh");
  for (const id of ["done-task", "busy-task", "failed-task", "redone-task"]) createTask(db, { id, runId:"run", kind:"bb", contract:{} });
  const now = 100_000_000;
  const at = (id:string, task:string, path:string, state:string, updatedAt = now - 60_000) => {
    createAttempt(db, { id, runId:"run", taskId:task });
    db.prepare("UPDATE lane_pilot_attempt SET workspace_path=?, state=?, updated_at=? WHERE id=?").run(path, state, updatedAt, id);
  };
  at("a", "done-task", "/lp/wt/a", "accepted");
  at("b", "busy-task", "/lp/wt/b", "running");
  // A failed attempt nothing replaced may still be redone in its worktree: it stays.
  at("c", "failed-task", "/lp/wt/c", "provider_error");
  at("d", "redone-task", "/lp/wt/d", "provider_error");
  at("e", "redone-task", "/lp/wt/e", "accepted");
  const calls: string[] = [];
  const remove = async (_host:string, _base:string, path:string) => { calls.push(path); return true; };
  const released = new Set<string>();
  expect(await cleanupStickyLaneWorktrees(db, remove, released, now)).toEqual([]);
  const later = now + 31 * 60_000;
  expect((await cleanupStickyLaneWorktrees(db, remove, released, later)).sort()).toEqual(["/lp/wt/a", "/lp/wt/d", "/lp/wt/e"]);
  expect(calls.sort()).toEqual(["/lp/wt/a", "/lp/wt/d", "/lp/wt/e"]);
});
