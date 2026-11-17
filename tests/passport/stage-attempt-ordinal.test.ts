import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createAttempt, createRun, openDatabase, saveStageReceipt, countAttempts } from "../../src/rooms/plugin-db";
import { recordStage, recordGateEvaluation, closeWriterStages } from "../../src/rooms/runs/server/stage-records";
import { passport, attemptRecord, subagentReceipts } from "../../src/rooms/tools/server/receipts";

// G1 root cause (q2 review 2026-11-17): recordStage clamped the receipt's attempt to Math.min(attempt,2) because the
// stage contract capped attempt at 2 — a guard added after fallback-chain writers (attempt_no 3,4) crashed the task
// with internal_error. `attempt` is a task-attempt ordinal (producers pass attempt_no/countAttempts; no per-stage
// retry identity exists — each row is the stage's latest state). The clamp made every attempt ≥3 indistinguishable
// from attempt 2 in receipts AND gate events, so passports and attempt records attribute a later attempt's work to
// attempt 2. Reproduction goes through the REAL producer (recordStage), not the storage helper.
function db() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const d = openDatabase(bb);
  createRun(d, "run", "proj", "bb", "/repo");
  d.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES('t','run','bb','{}',1)").run();
  return d;
}

describe("stage and gate rows keep the full attempt ordinal", () => {
  it("a third attempt's writer receipt lands on attempt 3, not clamped to 2", () => {
    const d = db();
    createAttempt(d, { id: "a1", runId: "run", taskId: "t" });
    createAttempt(d, { id: "a2", runId: "run", taskId: "t" });
    createAttempt(d, { id: "a3", runId: "run", taskId: "t" }); // fallback-chain attempt, attempt_no 3
    recordStage(d, { runId: "run", taskId: "t", stageId: "writer-agent", state: "passed", input: "plan", attempt: 3, providerId: "devin", model: "swe-2-flash-medium", threadId: "thr_w3", result: { ok: true } });

    const p3 = passport(d, "a3")!;
    expect(p3.stages).toContainEqual(expect.objectContaining({ stage: "writer-agent", state: "passed", provider: "devin", model: "swe-2-flash-medium" }));
    expect(passport(d, "a2")!.stages.find((s) => s.stage === "writer-agent")).toBeUndefined();
    expect(passport(d, "a1")!.stages.find((s) => s.stage === "writer-agent")).toBeUndefined();
  });

  it("gate evaluations keep the full ordinal for per-attempt records", () => {
    const d = db();
    createAttempt(d, { id: "a1", runId: "run", taskId: "t" });
    createAttempt(d, { id: "a2", runId: "run", taskId: "t" });
    createAttempt(d, { id: "a3", runId: "run", taskId: "t" });
    recordGateEvaluation(d, { projectId: "proj", runId: "run", taskId: "t", gate: "accept", status: "passed", attempt: 3, input: "{}", summary: { ok: true } });

    const r3 = attemptRecord(d, "a3")!;
    expect(r3.gateEvents).toContainEqual(expect.objectContaining({ gate: "accept", status: "passed" }));
    expect(attemptRecord(d, "a2")!.gateEvents.find((g) => g.gate === "accept")).toBeUndefined();
  });

  it("attempt 0/1/2 values pass through unchanged", () => {
    const d = db();
    createAttempt(d, { id: "a1", runId: "run", taskId: "t" });
    createAttempt(d, { id: "a2", runId: "run", taskId: "t" });
    recordStage(d, { runId: "run", taskId: "t", stageId: "pm-read", state: "skipped", input: "plan", attempt: 0, reason: "disabled" });
    recordStage(d, { runId: "run", taskId: "t", stageId: "plan-critique", state: "passed", input: "plan", attempt: 1, providerId: "claude-code", model: "claude-haiku-5-5", result: {} });
    recordStage(d, { runId: "run", taskId: "t", stageId: "code-critique", state: "passed", input: "plan", attempt: 2, providerId: "devin", model: "swe-2-flash-medium", result: {} });
    const rows = d.prepare("SELECT stage_id, attempt FROM lane_pilot_stage_receipt WHERE run_id='run' ORDER BY stage_id").all() as Array<{ stage_id: string; attempt: number }>;
    expect(rows).toEqual([
      { stage_id: "code-critique", attempt: 2 },
      { stage_id: "plan-critique", attempt: 1 },
      { stage_id: "pm-read", attempt: 0 },
    ]);
    // attempt-0 rows are task-scope evidence: visible on every attempt passport, never attempt proof.
    const p2 = passport(d, "a2")!;
    expect(p2.stages.filter((s) => s.scope === "attempt").map((s) => s.stage)).toEqual(["code-critique"]);
    expect(p2.stages.find((s) => s.stage === "pm-read")).toMatchObject({ scope: "task", attempt: 0 });
    const p1 = passport(d, "a1")!;
    expect(p1.stages.filter((s) => s.scope === "attempt").map((s) => s.stage)).toEqual(["plan-critique"]);
  });

  it("the production caller path keeps the ordinal: closeWriterStages with the caller's countAttempts lands on 3", () => {
    const d = db();
    createAttempt(d, { id: "a1", runId: "run", taskId: "t" });
    createAttempt(d, { id: "a2", runId: "run", taskId: "t" });
    createAttempt(d, { id: "a3", runId: "run", taskId: "t" });
    // Same call shape as dispatch-workflow/reopen-attempt/watch-writer/closeOrphanWriterStages:
    // attempt = countAttempts(run, task) at close time, not a literal.
    for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const)
      recordStage(d, { runId: "run", taskId: "t", stageId, state: "pending", input: "plan" });
    closeWriterStages(d, { runId: "run", taskId: "t", plan: "plan", terminal: "failed", attempt: countAttempts(d, "run", "t"), reason: "watchdog" });
    const attempts = d.prepare("SELECT stage_id, attempt FROM lane_pilot_stage_receipt WHERE run_id='run' AND task_id='t'").all() as Array<{ stage_id: string; attempt: number }>;
    expect(attempts.map((r) => r.attempt)).toEqual([3, 3, 3]);
    const p3 = passport(d, "a3")!;
    expect(p3.stages.map((s) => s.stage).sort()).toEqual(["acceptance-receipt", "verification", "writer-agent"].sort());
    expect(passport(d, "a2")!.stages.filter((s) => s.scope === "attempt")).toHaveLength(0);
  });

  it("an attempt-0 stage is task evidence, visible but scoped 'task' — never attempt proof", () => {
    const d = db();
    createAttempt(d, { id: "a1", runId: "run", taskId: "t" });
    createAttempt(d, { id: "a2", runId: "run", taskId: "t" });
    // A pre-attempt gate wrote attempt 0 (e.g. plan critique blocked before the attempt row existed).
    recordStage(d, { runId: "run", taskId: "t", stageId: "plan-critique", state: "blocked", input: "plan", attempt: 0, reason: "contract refused" });
    recordStage(d, { runId: "run", taskId: "t", stageId: "writer-agent", state: "passed", input: "plan", attempt: 2, providerId: "devin", model: "swe-2-flash-medium", result: {} });
    const p1 = passport(d, "a1")!;
    expect(p1.stages).toContainEqual(expect.objectContaining({ stage: "plan-critique", state: "blocked", scope: "task", attempt: 0 }));
    const p2 = passport(d, "a2")!;
    expect(p2.stages.find((s) => s.stage === "writer-agent")).toMatchObject({ scope: "attempt", attempt: 2 });
    expect(p2.stages.find((s) => s.stage === "plan-critique")).toMatchObject({ scope: "task" });
  });

  it("a stored ordinal of 2 on a task with more attempts is flagged ambiguous, never silently exact", () => {
    const d = db();
    createAttempt(d, { id: "a1", runId: "run", taskId: "t" });
    createAttempt(d, { id: "a2", runId: "run", taskId: "t" });
    createAttempt(d, { id: "a3", runId: "run", taskId: "t" });
    // Legacy signature: a row written while the 0-2 clamp was live could be attempt 2's own or a clamped 3+.
    saveStageReceipt(d, {
      runId: "run", taskId: "t", stageId: "plan-fact", contractVersion: 1, state: "passed",
      inputSha256: "i".repeat(64), outputSha256: "o".repeat(64), attempt: 2, providerId: "devin",
      model: "swe-2-flash-medium", threadId: "thr_w", result: { table: "ok", items: [] }, reason: null, updatedAt: 20,
    });
    const report = subagentReceipts(d, {});
    expect(report.coverage).toMatchObject({ checked: 0, ambiguous: 1, unknown: 2 });
    const p2 = passport(d, "a2")!;
    expect(p2.stages.find((s) => s.stage === "plan-fact")).toMatchObject({ ambiguous: true, attempt: 2 });
    expect(passport(d, "a3")!.stages).toHaveLength(0);
  });
});
