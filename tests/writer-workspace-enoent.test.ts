import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createRun, openDatabase, registerWorktree } from "../src/rooms/plugin-db";
import { reconcileWorktreeRegistry } from "../src/rooms/stability/server/worktree-janitor";
import { runCommandOnHost } from "../src/rooms/writer/cli-run";
import {STICKY_WINDOW_MS} from "../src/rooms/platform/server";
import samples from "./fixtures/writer-workspace-enoent/attempts.json";

function setup(origin = samples.origins[0]) {
  const bb = createFakePluginHost({ pluginId: "lane-pilot" }).bb;
  const db = openDatabase(bb);
  createRun(db, origin.run_id, "proj_acpiaqf4wq", "cli", samples.basePath);
  db.prepare("UPDATE lane_pilot_run SET writer_host_id=? WHERE id=?").run(samples.hostId, origin.run_id);
  const task = (id: string, area: string | null) => db.prepare("INSERT OR IGNORE INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES(?,?,'bb',?,0)")
    .run(id, origin.run_id, JSON.stringify({ area }));
  const attempt = (row: typeof origin | typeof samples.failures[number], state = row.state, updatedAt = row.updated_at) => {
    task(row.task_id, origin.area);
    db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,thread_id,state,attempt_no,reason,created_at,updated_at,workspace_path,environment_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(row.id, row.run_id, row.task_id, row.thread_id, state, row.attempt_no, row.reason, row.created_at, updatedAt, row.workspace_path, row.environment_id);
  };
  attempt(origin);
  registerWorktree(db, { host: samples.hostId, path: origin.workspace_path, branch: `lane/${origin.id}`, owner_kind: "attempt", owner_id: origin.id }, origin.created_at);
  const removed: string[] = [];
  const ctx = { bb, db, log: () => undefined, isDisposed: () => false,
    host: { call: async (_method: string, input: { worktreePath: string }) => { removed.push(input.worktreePath); return { removed: true }; } } };
  return { db, ctx, removed, attempt };
}

describe("the writer workspace survives its original attempt", () => {
  for (const origin of samples.origins) {
    it(`replays ${origin.thread_id}: a borrowed worktree stays readable through every captured failure`, async () => {
      const f = setup(origin);
      const dir = await mkdtemp(join(tmpdir(), "lp-writer-cwd-"));
      const cwd = join(dir, "selfystudio");
      await mkdir(cwd);
      execFileSync("git", ["init", "-q"], { cwd });
      await writeFile(join(cwd, "writer.txt"), "writer output\n");
      f.ctx.host.call = async (_method, input) => {
        expect(input.worktreePath).toBe(origin.workspace_path);
        f.removed.push(input.worktreePath);
        await rm(cwd, { recursive: true });
        return { removed: true };
      };
      try {
        for (const failure of samples.failures.filter((row) => row.workspace_path === origin.workspace_path)) {
          // State immediately before the captured validation_failed transition; keep its real identifiers and path.
          f.attempt(failure, "running", failure.created_at);
          await reconcileWorktreeRegistry(f.ctx as never, failure.updated_at - 1);
          const ran = await runCommandOnHost({ requestedHostId: samples.hostId, cwd, command: "git diff --name-only" });
          expect(ran.stderr).not.toContain("spawn /bin/bash ENOENT");
          expect(ran.exitCode).toBe(0);
          expect(f.removed).toEqual([]);
          f.db.prepare("UPDATE lane_pilot_attempt SET state=?,updated_at=? WHERE id=?").run(failure.state, failure.updated_at, failure.id);
        }
      } finally {
        f.db.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  it("keeps an accepted area's worktree between tasks, then releases it after the sticky window", async () => {
    const { ctx, db, removed } = setup();
    const origin = samples.origins[0];
    expect(await reconcileWorktreeRegistry(ctx as never, origin.updated_at + STICKY_WINDOW_MS)).toBe(0);
    expect(removed).toEqual([]);
    expect(await reconcileWorktreeRegistry(ctx as never, origin.updated_at + STICKY_WINDOW_MS + 1)).toBe(1);
    db.close();
  });

  it("keeps an expired creator's copy for a running borrower on the same host only", async () => {
    const { ctx, db, attempt, removed } = setup();
    const origin = samples.origins[0], next = samples.failures[0];
    const now = origin.updated_at + STICKY_WINDOW_MS + 60_000;
    attempt(next, "running", now - 4_000);
    expect(await reconcileWorktreeRegistry(ctx as never, now)).toBe(0);
    expect(removed).toEqual([]);
    db.prepare("UPDATE lane_pilot_run SET writer_host_id='other-host' WHERE id=?").run(origin.run_id);
    expect(await reconcileWorktreeRegistry(ctx as never, now)).toBe(1);
    db.close();
  });

  it("keeps a provisioning creator before its workspace is bound", async () => {
    const { ctx, db } = setup();
    const origin = samples.origins[0];
    db.prepare("UPDATE lane_pilot_attempt SET state='spawn_requested',workspace_path=NULL WHERE id=?").run(origin.id);
    expect(await reconcileWorktreeRegistry(ctx as never, origin.updated_at + STICKY_WINDOW_MS + 1)).toBe(0);
    db.close();
  });

  it.each(["blocked", "validation_failed"])("keeps a borrowed %s workspace for its reopen grace", async (state) => {
    const { ctx, db, attempt } = setup();
    const origin = samples.origins[0], next = samples.failures[0];
    const now = origin.updated_at + STICKY_WINDOW_MS + 60_000;
    attempt(next, state, now - 4_000);
    expect(await reconcileWorktreeRegistry(ctx as never, now)).toBe(0);
    expect(await reconcileWorktreeRegistry(ctx as never, now + 3 * 3_600_000)).toBe(1);
    db.close();
  });
});
