import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createAttempt, createRun, createTask, listStageReceipts, openDatabase, saveTaskPlan, transitionAttempt } from "../../src/rooms/storage/database";
import { closeOrphanWriterStages, recordStage } from "../../src/server/stage-records";

function setup() {
  const db = openDatabase(createFakePluginHost({ pluginId:"lane-pilot" }).bb);
  createRun(db, "run", "P", "cli", "/w");
  createTask(db, { id:"t", runId:"run", kind:"bb", contract:{} as never });
  createAttempt(db, { id:"a1", runId:"run", taskId:"t" });
  return db;
}

describe("attempt invariants (fleet audit 2026-10-03)", () => {
  it("an accepted or canceled attempt keeps its state, and every move is journaled", () => {
    const db = setup();
    transitionAttempt(db, "a1", "spawn_requested");
    expect(transitionAttempt(db, "a1", "running")).toBe(true);
    expect(transitionAttempt(db, "a1", "cancel_requested", { reason:"owner stopped it" })).toBe(true);
    expect(transitionAttempt(db, "a1", "canceled", { reason:"owner stopped it" })).toBe(true);
    // The merge finished after the cancel: it must not turn the attempt into «accepted».
    expect(transitionAttempt(db, "a1", "accepted")).toBe(false);
    expect((db.prepare("SELECT state FROM lane_pilot_attempt WHERE id='a1'").get() as { state:string }).state).toBe("canceled");
    const journal = db.prepare("SELECT from_state, to_state, refused FROM lane_pilot_attempt_transition WHERE attempt_id='a1' ORDER BY rowid").all();
    expect(journal).toEqual([
      { from_state:"queued", to_state:"spawn_requested", refused:0 },
      { from_state:"spawn_requested", to_state:"running", refused:0 },
      { from_state:"running", to_state:"cancel_requested", refused:0 },
      { from_state:"cancel_requested", to_state:"canceled", refused:0 },
      { from_state:"canceled", to_state:"accepted", refused:1 },
    ]);
    expect(transitionAttempt(db, "missing", "running")).toBe(false);
  });

  it("closes writer stages left open after the task's attempt was accepted, but not those of work in flight", () => {
    const db = setup();
    saveTaskPlan(db, "t", "Fix the hero");
    for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) recordStage(db, { runId:"run", taskId:"t", stageId, state:"pending", input:"Fix the hero" });
    recordStage(db, { runId:"run", taskId:"t", stageId:"writer-agent", state:"running", input:"Fix the hero" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running");
    expect(closeOrphanWriterStages(db, new Set())).toBe(0);
    transitionAttempt(db, "a1", "accepted");
    expect(closeOrphanWriterStages(db, new Set(["run:t"]))).toBe(0);
    expect(closeOrphanWriterStages(db, new Set())).toBe(3);
    expect(listStageReceipts(db, "run", "t").filter((row) => ["writer-agent", "verification", "acceptance-receipt"].includes(row.stageId)).map((row) => row.state))
      .toEqual(["passed", "passed", "passed"]);
    expect(closeOrphanWriterStages(db, new Set())).toBe(0);
  });

  it("ends a failed attempt whose retry was lost in a reload, and closes its stages (live: bot-preset-catalog-style-fallback-r3)", () => {
    const db = setup();
    saveTaskPlan(db, "t", "Fix the hero");
    for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) recordStage(db, { runId:"run", taskId:"t", stageId, state:"pending", input:"Fix the hero" });
    recordStage(db, { runId:"run", taskId:"t", stageId:"writer-agent", state:"running", input:"Fix the hero" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running");
    transitionAttempt(db, "a1", "empty_output", { reason:"writer changed no files" });
    // The start loop of this process still owns it: not an orphan.
    expect(closeOrphanWriterStages(db, new Set(["run:t"]))).toBe(0);
    expect(closeOrphanWriterStages(db, new Set())).toBe(3);
    expect(db.prepare("SELECT state, reason FROM lane_pilot_attempt WHERE id='a1'").get())
      .toEqual({ state:"blocked", reason:"writer changed no files; its retry was lost in a plugin reload" });
    expect(listStageReceipts(db, "run", "t").filter((row) => ["writer-agent", "verification", "acceptance-receipt"].includes(row.stageId)).map((row) => row.state))
      .toEqual(["failed", "failed", "failed"]);
  });
});
