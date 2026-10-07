import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createAttempt, createRun, getAttempt, listStageReceipts, openDatabase, saveTaskPlan, transitionAttempt } from "../../src/database";
import { recordStage } from "../../src/server/stage-records";
import { createStability } from "../../src/server/stability";
import type { Services } from "../../src/server/services";
import { createTaskReconcile } from "../../src/server/task-reconcile";

/** A run with one task whose failed attempt waits for a retry that died with a reload (live: bot-preset-catalog-style-fallback-r3). */
function setup() {
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot", sdk:{ threads:{ send:async () => ({}) } } as never });
  const db = openDatabase(bb);
  createRun(db, "run", "proj", "cli", "/repo");
  db.prepare("UPDATE lane_pilot_run SET pm_thread_id='pm' WHERE id='run'").run();
  db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES('T1','run','bb','{}',1)").run();
  saveTaskPlan(db, "T1", "Fix the hero");
  const resumed:string[] = [];
  const order:string[] = [];
  const services = { activeWriterTasks:new Set<string>(),
    enqueueResumedWriter:async (_projectId:string, attempt:{ task_id:string }) => { resumed.push(attempt.task_id); return true; },
    resumeOrphans:async () => { order.push("resume"); } } as unknown as Services;
  const ctx = { bb, db, log:() => undefined, isDisposed:() => false } as never;
  Object.assign(services, createStability(ctx, services));
  const { reconcileTasks } = createTaskReconcile(ctx, services);
  const lostRetry = (updatedAt:number) => {
    for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) recordStage(db, { runId:"run", taskId:"T1", stageId, state:"pending", input:"Fix the hero" });
    recordStage(db, { runId:"run", taskId:"T1", stageId:"writer-agent", state:"running", input:"Fix the hero" });
    createAttempt(db, { id:"a1", runId:"run", taskId:"T1" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running");
    transitionAttempt(db, "a1", "empty_output", { reason:"writer changed no files" });
    db.prepare("UPDATE lane_pilot_attempt SET updated_at=? WHERE id='a1'").run(updatedAt);
  };
  return { db, services, reconcileTasks, resumed, order, lostRetry };
}

describe("ordered task reconcile", () => {
  it("ends, parks and restarts a retry lost in a reload in the SAME start-up pass", async () => {
    const { db, services, reconcileTasks, resumed, order, lostRetry } = setup();
    lostRetry(Date.now() - 60_000);
    await reconcileTasks({ phase:"startup", afterResume:() => { order.push("sweeps"); } });
    // The stage cleanup ended the attempt, parking took it over, and the sweep restarted it without waiting for a next start.
    expect(order).toEqual(["resume", "sweeps"]);
    expect(resumed).toEqual(["T1"]);
    expect(getAttempt(db, "a1")?.state).toBe("blocked");
    expect(getAttempt(db, "a1")?.reason).toContain("its retry was lost in a plugin reload");
    expect(await services.stability.loadParked()).toEqual([]); // restarted: no longer parked
    expect(listStageReceipts(db, "run", "T1").find((row) => row.stageId === "writer-agent")?.state).toBe("pending"); // reopened for the restart
  });

  it("parks it when the restart is not due yet (a machine fault waits out its backoff)", async () => {
    const { db, services, reconcileTasks, resumed } = setup();
    for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) recordStage(db, { runId:"run", taskId:"T1", stageId, state:"pending", input:"Fix the hero" });
    createAttempt(db, { id:"a1", runId:"run", taskId:"T1" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running");
    transitionAttempt(db, "a1", "provider_error", { reason:"ENOSPC: no space left on device" });
    await reconcileTasks({ phase:"startup" });
    expect(getAttempt(db, "a1")?.state).toBe("blocked");
    expect((await services.stability.loadParked()).map((row) => `${row.taskId}:${row.klass}`)).toEqual(["T1:infra"]);
    expect(resumed).toEqual([]);
  });

  it("the periodic pass leaves an attempt that moved a moment ago to the loop that may still own it", async () => {
    const { db, reconcileTasks, resumed, order, lostRetry } = setup();
    lostRetry(Date.now() - 5_000);
    await reconcileTasks({ phase:"periodic" });
    expect(order).toEqual([]); // no resume of attempts in flight outside start-up
    expect(getAttempt(db, "a1")?.state).toBe("empty_output");
    expect(resumed).toEqual([]);
    await reconcileTasks({ phase:"periodic", now:Date.now() + 10 * 60_000 });
    expect(getAttempt(db, "a1")?.state).toBe("blocked");
    expect(resumed).toEqual(["T1"]);
  });

  it("never touches a task a loop of this process works on", async () => {
    const { db, services, reconcileTasks, resumed, lostRetry } = setup();
    lostRetry(Date.now() - 60_000);
    services.activeWriterTasks.add("run:T1");
    await reconcileTasks({ phase:"periodic" });
    expect(getAttempt(db, "a1")?.state).toBe("empty_output");
    expect(resumed).toEqual([]);
  });

  it("one failing step does not stop the ones after it", async () => {
    const { services, reconcileTasks, db, lostRetry } = setup();
    lostRetry(Date.now() - 60_000);
    services.resumeOrphans = async () => { throw new Error("host offline"); };
    await reconcileTasks({ phase:"startup" });
    expect(getAttempt(db, "a1")?.state).toBe("blocked");
  });
});
