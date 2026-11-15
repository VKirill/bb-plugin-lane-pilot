import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { countAttempts, createAttempt, createRun, createTask, listStageReceipts, openDatabase } from "../src/rooms/plugin-db";
import { recordStage } from "../src/rooms/runs/server/stage-records";
import { createStability } from "../src/rooms/stability/server/stability";
import incident from "./fixtures/parked-deleted-pm-2026-11-15.json";

const databases:ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function setup() {
  const get = vi.fn(async (_args:{threadId:string}):Promise<unknown> => ({ id:incident.pmThreadId, archivedAt:null }));
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot", sdk:{ threads:{ get } } as never });
  const db = openDatabase(bb);
  databases.push(db);
  createRun(db, incident.runId, incident.projectId, "cli", "/repo");
  db.prepare("UPDATE lane_pilot_run SET pm_thread_id=?, state='blocked' WHERE id=?").run(incident.pmThreadId, incident.runId);
  createTask(db, { id:incident.taskId, runId:incident.runId, kind:"bb", contract:{} });
  createAttempt(db, { id:incident.attemptId, runId:incident.runId, taskId:incident.taskId });
  db.prepare("UPDATE lane_pilot_attempt SET state='blocked', reason=?, created_at=?, updated_at=?, harness_version=? WHERE id=?")
    .run(incident.reason, incident.createdAt, incident.updatedAt, incident.harnessVersion, incident.attemptId);
  for (const state of ["pending", "running", "failed"] as const)
    recordStage(db, { runId:incident.runId, taskId:incident.taskId, stageId:"writer-agent", state, input:"captured plan", reason:incident.reason });
  const enqueueResumedWriter = vi.fn(async () => true);
  const { stability } = createStability({ bb, db, isDisposed:() => false, log:() => undefined } as never,
    { activeWriterTasks:new Set(), enqueueResumedWriter } as never);
  return { bb, db, get, enqueueResumedWriter, stability };
}

describe("parked retries whose PM was deleted (hub 2026-11-15)", () => {
  it("resumes a parked run that was never assigned a PM without reading a thread", async () => {
    const { db, get, enqueueResumedWriter, stability } = setup();
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id=NULL WHERE id=?").run(incident.runId);
    await stability.onTaskFailed({ projectId:incident.projectId, runId:incident.runId, taskId:incident.taskId,
      pmThreadId:"", state:"blocked", reason:"ENOSPC: no space left" }, incident.sweepAt);

    expect(await stability.sweep(incident.sweepAt + 11 * 60_000)).toEqual([incident.taskId]);
    expect(enqueueResumedWriter).toHaveBeenCalledOnce();
    expect(countAttempts(db, incident.runId, incident.taskId)).toBe(2);
    expect(get).not.toHaveBeenCalled();
  });

  it.each(["missing", "soft-deleted", "archived"])("does not create another attempt or reopen stages for a %s PM", async (state) => {
    const { db, get, enqueueResumedWriter, stability } = setup();
    // An existing ticket outlives the PM, as it did before both reported restarts.
    expect(await stability.adoptBlockedByFaults(incident.sweepAt)).toEqual([incident.taskId]);
    if (state === "missing") get.mockRejectedValue(new Error(incident.parentReadError));
    else get.mockResolvedValue({ id:incident.pmThreadId, [state === "soft-deleted" ? "deletedAt" : "archivedAt"]:incident.updatedAt });

    expect(await stability.sweep(incident.sweepAt)).toEqual([]);
    expect(countAttempts(db, incident.runId, incident.taskId)).toBe(1);
    expect(enqueueResumedWriter).not.toHaveBeenCalled();
    expect(listStageReceipts(db, incident.runId, incident.taskId).find((row) => row.stageId === "writer-agent")?.state).toBe("failed");
    expect(await stability.loadParked()).toEqual([]);
    // The next periodic adoption must not recreate the discarded ticket.
    expect(await stability.adoptBlockedByFaults(incident.sweepAt + 60_000)).toEqual([]);
    expect(get).toHaveBeenCalledWith({ threadId:incident.pmThreadId });
  });

  it("keeps a ticket on a transient PM read failure and resumes it once the read succeeds", async () => {
    const { db, get, enqueueResumedWriter, stability } = setup();
    await stability.adoptBlockedByFaults(incident.sweepAt);
    const parked = await stability.loadParked();
    get.mockRejectedValueOnce(new Error("HTTP 503: temporarily unavailable"));
    expect(await stability.sweep(incident.sweepAt)).toEqual([]);
    expect(await stability.loadParked()).toEqual(parked);
    expect(countAttempts(db, incident.runId, incident.taskId)).toBe(1);
    expect(await stability.sweep(incident.sweepAt + 60_000)).toEqual([incident.taskId]);
    expect(enqueueResumedWriter).toHaveBeenCalledOnce();
    expect(countAttempts(db, incident.runId, incident.taskId)).toBe(2);
  });
});
