import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createAttempt, createRun, createTask, getRun, openDatabase, setRunThread, transitionAttempt } from "../src/database";
import { closeAbandonedRuns } from "../src/server/run-finish";

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
    transitionAttempt(db, "attempt_busy", "running", { threadId:"thr_writer" });

    const closed = await closeAbandonedRuns(bb, db, now);
    expect(closed.sort()).toEqual(["run_archived", "run_deleted", "run_orphan_old"]);
    for (const id of ["run_live", "run_idle", "run_flaky", "run_busy", "run_orphan_new"]) expect(getRun(db, id)?.closed_at).toBeNull();
    expect(getRun(db, "run_deleted")?.state).toBe("closed");
    await harness.lifecycle.dispose();
  });
});
