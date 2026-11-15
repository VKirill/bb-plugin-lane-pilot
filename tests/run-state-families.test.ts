import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { activeRunForProject, claimActivation, closeRun, createAttempt, createRun, createTask, getRun, listTaskLatestAttempts, listTaskTerminalStates, openDatabase, setRunState, transitionAttempt } from "../src/rooms/plugin-db";
import { aggregateRun } from "../src/rooms/runs/aggregation";
import { recordStage } from "../src/rooms/runs/server/stage-records";
import type { AttemptState } from "../src/rooms/contracts/state-machine";

// magicseo (2026-10-30): every family accepted, the run still ended «blocked» on the replaced T1.3, T3.2, T5…
describe("a run's state counts task families", () => {
  it("is accepted when the latest member of every family is", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    createRun(db, "run", "proj", "cli", "/repo");
    let at = 0;
    const task = (id: string, state: string) => {
      at += 1000;
      db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES(?,?,'bb','{}',?)").run(id, "run", at);
      db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,attempt_no,reason,created_at,updated_at) VALUES(?,?,?,?,1,NULL,?,?)").run(`a-${id}`, "run", id, state, at, at);
    };
    task("T1.3", "blocked"); task("T1.4", "accepted");
    task("T3", "blocked"); task("T3.2", "blocked"); task("T3.3", "canceled"); task("T3.4", "accepted");
    task("F1", "accepted"); task("F1.2", "accepted");
    expect(listTaskTerminalStates(db, "run")).toEqual(["accepted", "accepted", "accepted"]);
    expect(aggregateRun(listTaskTerminalStates(db, "run") as AttemptState[])).toBe("accepted");
    task("T5.2", "blocked");
    expect(aggregateRun(listTaskTerminalStates(db, "run") as AttemptState[])).toBe("blocked");
  });
});

// 2026-11-15 layers audit (F8): setRunState wrote any run, so a refresh after the close (lane_pilot_update_task on a
// gate-blocked task, an activation that still names the run) put a closed run back to «running» with closed_at set,
// and activeRunForProject showed it as the project's open run. Nothing reopens a run.
describe("a closed run", () => {
  it("keeps «closed» under a late state write and is never the project's active run", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    createRun(db, "run", "proj", "cli", "/repo");
    expect(closeRun(db, "run", "rpc")).toBe(true);
    setRunState(db, "run", "running");
    expect(getRun(db, "run")?.state).toBe("closed");
    db.prepare("UPDATE lane_pilot_run SET state='running' WHERE id='run'").run();
    expect(activeRunForProject(db, "proj")).toBeUndefined();
    createRun(db, "run2", "proj", "cli", "/repo");
    setRunState(db, "run2", "running");
    expect(getRun(db, "run2")?.state).toBe("running");
    expect(activeRunForProject(db, "proj")?.id).toBe("run2");
  });
});

// 2026-11-15 layers audit (F1): the run's state read the latest attempt state alone, so a task whose writer loop gave up on
// timeout/provider_error/validation_failed… kept its run «running» (closed by the 6 h stale sweep, shown at work). A retry is
// a new attempt row: the writer-agent stage tells the gap before it (still open) from the end (the loop closed it).
describe("a run between two attempts of a writer loop", () => {
  const world = () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    createRun(db, "run", "proj", "cli", "/repo");
    const task = (id: string) => createTask(db, { id, runId: "run", kind: "bb", contract: { id } });
    const attempt = (id: string, taskId: string, ...states: string[]) => {
      createAttempt(db, { id, runId: "run", taskId });
      for (const state of states) transitionAttempt(db, id, state);
    };
    const stage = (taskId: string, state: "running" | "failed") =>
      recordStage(db, { runId: "run", taskId, stageId: "writer-agent", state, input: "plan", ...(state === "failed" ? { reason: "retry limit 2 exhausted" } : {}) });
    // What core's refreshRun does: the latest attempt of each task with its writer stage, aggregated and written.
    const refresh = () => { setRunState(db, "run", aggregateRun(listTaskLatestAttempts(db, "run"))); return getRun(db, "run")?.state; };
    return { db, task, attempt, stage, refresh };
  };

  it("stays running from the failed attempt through the next queued one to acceptance", () => {
    const w = world();
    w.task("t"); w.attempt("a1", "t", "spawn_requested", "running", "validation_failed"); w.stage("t", "running");
    expect(w.refresh()).toBe("running");
    w.attempt("a2", "t");
    expect(w.refresh()).toBe("running");
    for (const next of ["spawn_requested", "running", "accepted"]) transitionAttempt(w.db, "a2", next);
    expect(w.refresh()).toBe("accepted");
    expect(getRun(w.db, "run")?.closed_at).toBeNull();
  });

  it("keeps the project held when another task refreshes the run inside the gap: no second activation", () => {
    const w = world();
    w.task("done"); w.attempt("a-done", "done", "spawn_requested", "running", "accepted");
    w.task("t"); w.attempt("a1", "t", "spawn_requested", "running", "timeout"); w.stage("t", "running");
    claimActivation(w.db, { projectId: "proj", pmThreadId: "pm-1", runId: "run" });
    expect(w.refresh()).toBe("running");
    createRun(w.db, "run-2", "proj", "cli", "/repo");
    expect(() => claimActivation(w.db, { projectId: "proj", pmThreadId: "pm-2", runId: "run-2" })).toThrow(/already active/);
  });

  it("is blocked once the writer loop closes on a failure or a cancel", () => {
    const w = world();
    w.task("t"); w.attempt("a1", "t", "spawn_requested", "running", "provider_error"); w.stage("t", "running"); w.stage("t", "failed");
    expect(w.refresh()).toBe("blocked");
    w.task("c"); w.attempt("a-c", "c", "spawn_requested", "running", "timeout"); w.stage("c", "running");
    expect(w.refresh()).toBe("running");
    recordStage(w.db, { runId: "run", taskId: "c", stageId: "writer-agent", state: "canceled", input: "plan", reason: "canceled by PM" });
    expect(w.refresh()).toBe("blocked");
  });

  it("stays running through a long legitimate retry: no clock frees the project while the loop's stage is open", () => {
    const w = world();
    w.task("t"); w.attempt("a1", "t", "spawn_requested", "running", "validation_failed"); w.stage("t", "running");
    w.db.prepare("UPDATE lane_pilot_attempt SET updated_at=? WHERE id='a1'").run(Date.now() - 6 * 3_600_000);
    claimActivation(w.db, { projectId: "proj", pmThreadId: "pm-1", runId: "run" });
    expect(w.refresh()).toBe("running");
    createRun(w.db, "run-2", "proj", "cli", "/repo");
    expect(() => claimActivation(w.db, { projectId: "proj", pmThreadId: "pm-2", runId: "run-2" })).toThrow(/already active/);
  });
});
