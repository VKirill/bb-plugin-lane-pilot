import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createAttempt, createRun, openDatabase, saveStageReceipt } from "../../src/rooms/plugin-db";
import { subagentReceipts } from "../../src/rooms/tools/server/receipts";

// Minimal reproduction of the phantom-scan attribution gap flagged in P07.05 review (2026-11-17):
// lane_pilot_stage_receipt keeps ONE row per (run,task,stage) — last writer wins. subagentReceipts iterates
// attempt refs but reads the task-level row, so N attempts of one task count the SAME last-writer receipt
// N times and an overwritten attempt's receipt is silently absent instead of an explicit "unknown".
// TEST-ONLY reproduction in lane swe-roadmap-4-phantom: asserts the DESIRED per-attempt semantics; no source fix
// until this regression settles the contract (current code fails this test — that is the reproduction).
function db() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const d = openDatabase(bb);
  createRun(d, "run", "proj", "bb", "/repo");
  d.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES('t','run','bb','{}',1)").run();
  return d;
}

describe("subagentReceipts attributes plan-fact receipts per attempt", () => {
  it("counts a task's surviving receipt once for the attempt that wrote it and reports the overwritten attempt as unknown", () => {
    const d = db();
    createAttempt(d, { id: "a1", runId: "run", taskId: "t" }); // attempt_no 1 (blocked on a provider error)
    createAttempt(d, { id: "a2", runId: "run", taskId: "t" }); // attempt_no 2 (respawn, accepted)
    // Only attempt 2's plan-fact row survives in the rollup (attempt 1's was overwritten by the upsert).
    saveStageReceipt(d, {
      runId: "run", taskId: "t", stageId: "plan-fact", contractVersion: 1, state: "passed",
      inputSha256: "i", outputSha256: "o", attempt: 2, providerId: "devin", model: "swe-2-flash-medium",
      threadId: "thr_w2", result: { table: "ok", items: [] }, reason: null, updatedAt: 20,
    });
    const report = subagentReceipts(d, {});
    expect(report.attempts).toBe(2);
    // Desired semantics: the surviving row belongs to attempt 2 only; attempt 1's plan-fact is absent → unknown.
    expect(report.coverage).toMatchObject({ checked: 1, skipped: 0 });
    expect((report.coverage as Record<string, unknown>).unknown).toBe(1);
    // Phantom evidence must not duplicate per attempt iteration.
    expect(report.phantoms).toHaveLength(0);
  });

  it("phantoms scan once per distinct task even when several attempts share it", () => {
    const d = db();
    createAttempt(d, { id: "a1", runId: "run", taskId: "t" });
    createAttempt(d, { id: "a2", runId: "run", taskId: "t" });
    saveStageReceipt(d, {
      runId: "run", taskId: "t", stageId: "plan-fact", contractVersion: 1, state: "failed",
      inputSha256: "i", outputSha256: "o", attempt: 2, providerId: null, model: null,
      threadId: null, result: { table: "ok", items: [{ item: 1, evidence: [{ evidence: "src/gone.ts", code: "file_not_in_diff" }] }] }, reason: null, updatedAt: 20,
    });
    const report = subagentReceipts(d, {});
    // Two attempts of one task, one surviving row: coverage is per attempt (checked 1 + unknown 1),
    // the task-level finding is reported exactly once.
    expect(report.coverage).toMatchObject({ checked: 1, unknown: 1 });
    expect(report.phantoms).toEqual([{ taskId: "t", evidence: "src/gone.ts", code: "file_not_in_diff" }]);
  });

  it("an attempt-0 plan-fact row is unknown coverage for every attempt but still scanned once as task evidence", () => {
    const d = db();
    createAttempt(d, { id: "a1", runId: "run", taskId: "t" });
    saveStageReceipt(d, {
      runId: "run", taskId: "t", stageId: "plan-fact", contractVersion: 1, state: "failed",
      inputSha256: "i", outputSha256: "o", attempt: 0, providerId: null, model: null,
      threadId: null, result: { table: "ok", items: [{ item: 1, evidence: [{ evidence: "src/x.ts", code: "file_missing" }] }] }, reason: null, updatedAt: 20,
    });
    const report = subagentReceipts(d, {});
    // attempt 0 is pre-attempt/task evidence — no attempt claims it.
    expect(report.coverage).toMatchObject({ unknown: 1, checked: 0 });
    expect(report.phantoms).toEqual([{ taskId: "t", evidence: "src/x.ts", code: "file_missing" }]);
  });

  it("attempts outside the window contribute neither coverage nor phantoms", () => {
    const d = db();
    createAttempt(d, { id: "a_old", runId: "run", taskId: "t" });
    // Push the attempt before the scan window: subagentReceipts({days:1}) cuts at now-24h.
    d.prepare("UPDATE lane_pilot_attempt SET created_at=? WHERE id='a_old'").run(Date.now() - 3 * 86_400_000);
    saveStageReceipt(d, {
      runId: "run", taskId: "t", stageId: "plan-fact", contractVersion: 1, state: "failed",
      inputSha256: "i", outputSha256: "o", attempt: 1, providerId: null, model: null,
      threadId: null, result: { table: "ok", items: [{ item: 1, evidence: [{ evidence: "src/old.ts", code: "file_missing" }] }] }, reason: null, updatedAt: 20,
    });
    const report = subagentReceipts(d, { days: 1 });
    expect(report.attempts).toBe(0);
    expect(report.phantoms).toHaveLength(0);
  });
});
