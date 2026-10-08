import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createAttempt, createRun, createTask, getRun, openDatabase, setRunThread, transitionAttempt } from "../src/rooms/storage/database";
import { cleanupRunEnvironments, closeAbandonedRuns } from "../src/server/run-finish";
import { isProjectRootCheckout } from "../src/server/writer/spawn";

describe("abandoned run sweep", () => {
  it("closes runs whose PM chat is deleted or archived and day-old runs without a chat, and nothing else", async () => {
    const { bb: host, harness } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = openDatabase(host);
    const day = 24 * 60 * 60 * 1000;
    const threads: Record<string, unknown> = {
      thr_live: { id:"thr_live", status:"active", archivedAt:null },
      thr_idle: { id:"thr_idle", status:"idle", archivedAt:null },
      thr_archived: { id:"thr_archived", status:"idle", archivedAt:5 },
      thr_busy: { id:"thr_busy", status:"idle", archivedAt:5 },
    };
    const bb = { sdk: { threads: { get: async ({ threadId }: { threadId: string }) => {
      if (threadId === "thr_flaky") throw new Error("HTTP 500: hub busy");
      if (!(threadId in threads)) throw new Error("HTTP 404: thread not found");
      return threads[threadId];
    } } } } as never;
    for (const [id, thread] of [["run_live", "thr_live"], ["run_idle", "thr_idle"], ["run_archived", "thr_archived"], ["run_deleted", "thr_gone"], ["run_flaky", "thr_flaky"], ["run_busy", "thr_busy"]] as const) {
      createRun(db, id, "P", "cli");
      setRunThread(db, id, thread);
    }
    createRun(db, "run_orphan_old", "P");
    createRun(db, "run_orphan_new", "P");
    const now = Date.now() + 2 * day;
    db.prepare("UPDATE lane_pilot_run SET created_at=? WHERE id='run_orphan_new'").run(now - 60_000);
    createTask(db, { id:"task_busy", runId:"run_busy", kind:"bb", contract:{} });
    createAttempt(db, { id:"attempt_busy", runId:"run_busy", taskId:"task_busy" });
    transitionAttempt(db, "attempt_busy", "spawn_requested");
    transitionAttempt(db, "attempt_busy", "running", { threadId:"thr_writer" });

    const closed = await closeAbandonedRuns(bb, db, now);
    expect(closed.sort()).toEqual(["run_archived", "run_deleted", "run_orphan_old"]);
    for (const id of ["run_live", "run_idle", "run_flaky", "run_busy", "run_orphan_new"]) expect(getRun(db, id)?.closed_at).toBeNull();
    expect(getRun(db, "run_deleted")?.state).toBe("closed");
    await harness.lifecycle.dispose();
  });
});

describe("attempt environments", () => {
  it("archives a closed run's BB worktrees for BB to retire, never the run's own checkout, and survives a refusal", async () => {
    const { bb: host, harness } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = openDatabase(host);
    const calls: string[] = [];
    const bb = {
      log: { warn: (message: string) => calls.push(`warn:${message.slice(0, 40)}`) },
      sdk: { environments: {
        archiveThreads: async ({ environmentId }: { environmentId: string }) => { calls.push(`archive:${environmentId}`); return {}; },
        delete: async ({ environmentId }: { environmentId: string }) => {
          if (environmentId === "env_busy") throw new Error("HTTP 409: Environment still has live threads");
          // A just-archived environment is still «ready»; BB retires it on its own a few minutes later.
          calls.push(`delete:${environmentId}`); throw new Error("HTTP 409: Environment cannot be deleted while ready");
        },
      } },
    } as never;
    createRun(db, "run_env", "P", "cli");
    db.prepare("UPDATE lane_pilot_run SET writer_environment_id='env_checkout' WHERE id='run_env'").run();
    createTask(db, { id:"task_env", runId:"run_env", kind:"bb", contract:{} });
    for (const [id, env] of [["a1", "env_attempt"], ["a2", "env_checkout"], ["a3", "env_busy"], ["a4", null]] as const) {
      createAttempt(db, { id, runId:"run_env", taskId:"task_env" });
      if (env) db.prepare("UPDATE lane_pilot_attempt SET environment_id=? WHERE id=?").run(env, id);
    }
    expect(await cleanupRunEnvironments(bb, db, "run_env")).toEqual(["env_attempt"]);
    expect(calls).toContain("archive:env_attempt");
    expect(calls).toContain("delete:env_attempt");
    expect(calls.some((call) => call.includes("env_checkout"))).toBe(false);
    expect(calls.some((call) => call.startsWith("warn:"))).toBe(true);
    await harness.lifecycle.dispose();
  });

  it("hands a writer BB's worktree only when the run works in the project's own checkout on that machine", async () => {
    const bb = { sdk: { projects: { get: async () => ({ sources: [{ hostId: "ovh", path: "/home/ubuntu/apps/selfystudio" }, { hostId: "mini", path: "/Users/me/SelfyStudio" }] }) } } };
    expect(await isProjectRootCheckout(bb, "P", "ovh", "/home/ubuntu/apps/selfystudio/")).toBe(true);
    expect(await isProjectRootCheckout(bb, "P", "ovh", "/home/ubuntu/apps/selfystudio/apps/bot")).toBe(false);
    expect(await isProjectRootCheckout(bb, "P", "mini", "/home/ubuntu/apps/selfystudio")).toBe(false);
    expect(await isProjectRootCheckout({ sdk: { projects: { get: async () => { throw new Error("offline"); } } } }, "P", "ovh", "/x")).toBe(false);
  });
});
