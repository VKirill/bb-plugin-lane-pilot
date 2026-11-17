import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createAttempt, createRun, openDatabase, saveStageReceipt, transitionAttempt } from "../../src/rooms/plugin-db";
import { passport } from "../../src/rooms/tools/server/receipts";

// Live incident 2026-11-17 (run lprun_d97f…, task p0705-diag-probe): attempt_no 1's writer was refused by its
// provider (opencode2, usage limit) and went `blocked`; the automatic respawn attempt_no 2 passed on
// devin/swe-2-flash-medium. `passport <attempt-1>` then reported writer-agent "passed devin" — attempt-2's
// receipt — because stage rows keyed (run_id, task_id, stage_id) hold only the last writer and passport read
// the task-level rollup without the attempt filter attemptRecord applies.
function db() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const d = openDatabase(bb);
  createRun(d, "run", "proj", "bb", "/repo");
  d.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES('t','run','bb','{}',1)").run();
  return d;
}

describe("an attempt's passport lists that attempt's stage receipts, not the task rollup", () => {
  it("does not show a later attempt's writer receipt under an earlier attempt's header", () => {
    const d = db();
    createAttempt(d, { id: "a1", runId: "run", taskId: "t" }); // attempt_no 1
    createAttempt(d, { id: "a2", runId: "run", taskId: "t" }); // attempt_no 2
    transitionAttempt(d, "a1", "blocked", { reason: "writer thread status error: provider_error: usage limit" });
    transitionAttempt(d, "a2", "accepted");
    // Attempt 1's own writer receipt, then attempt 2 overwrites the same (run,task,stage) row.
    saveStageReceipt(d, { runId: "run", taskId: "t", stageId: "writer-agent", contractVersion: 1, state: "failed", inputSha256: "i1", outputSha256: null, attempt: 1, providerId: "opencode2", model: "longcat/LongCat-2.5", threadId: "thr_w1", result: null, reason: "provider_error", updatedAt: 10 });
    saveStageReceipt(d, { runId: "run", taskId: "t", stageId: "writer-agent", contractVersion: 1, state: "passed", inputSha256: "i1", outputSha256: "o2", attempt: 2, providerId: "devin", model: "swe-2-flash-medium", threadId: "thr_w2", result: null, reason: null, updatedAt: 20 });
    // A stage only attempt 1 produced survives in the rollup and belongs in a1's passport.
    saveStageReceipt(d, { runId: "run", taskId: "t", stageId: "code-critique", contractVersion: 1, state: "failed", inputSha256: "i1", outputSha256: null, attempt: 1, providerId: "opencode2", model: "longcat/LongCat-2.5", threadId: "thr_w1", result: null, reason: "provider_error", updatedAt: 10 });

    const p1 = passport(d, "a1")!;
    const p2 = passport(d, "a2")!;
    expect(p1.attempt.state).toBe("blocked");
    expect(p1.stages.find((s) => s.stage === "writer-agent")).toBeUndefined();
    expect(p1.stages.find((s) => s.provider === "devin")).toBeUndefined();
    expect(p1.stages.find((s) => s.stage === "code-critique")).toMatchObject({ state: "failed", provider: "opencode2" });
    expect(p2.stages.find((s) => s.stage === "writer-agent")).toMatchObject({ state: "passed", provider: "devin", model: "swe-2-flash-medium" });
    expect(p2.stages.find((s) => s.stage === "code-critique")).toBeUndefined();
  });
});
