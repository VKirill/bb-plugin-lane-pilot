import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { createAttempt, createRun, openDatabase } from "../../src/database";
import { cleanupFinishedAttemptEnvironments } from "../../src/server/run-finish";

async function sweep(snapshotStatus: "clean" | "saved" | "failed" = "clean") {
  const deleted: string[] = [], snapshots: string[] = [];
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot", sdk:{
    environments:{
      get:async ({ environmentId }: { environmentId:string }) => ({ id:environmentId, hostId:"ovh", path:`/wt/${environmentId}`, lifecycle:{ phase:"active" } }),
      archiveThreads:async () => undefined,
      delete:async ({ environmentId }: { environmentId:string }) => { deleted.push(environmentId); },
    },
    threads:{ get:async ({ threadId }: { threadId:string }) => ({ id:threadId, environmentId:`env_of_${threadId}` }) },
  } as never });
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
    return { status:snapshotStatus, path:snapshotStatus === "saved" ? `/released/${name}.patch` : null, reason:snapshotStatus === "failed" ? "disk" : null };
  }, now);
  return { removed:removed.sort(), deleted:deleted.sort(), snapshots };
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
