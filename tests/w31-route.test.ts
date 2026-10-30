import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createAttempt, createRun, createTask, openDatabase, transitionAttempt } from "../src/rooms/storage/database";
import { attemptMetrics, queueWaitMs, runQueueWaits } from "../src/rooms/usage/server/attempt-metrics";
import { markCancelCode, cancelAttemptById, CANCEL_CODES } from "../src/rooms/runs/server/cancel";
import { sweepWriterModelOutcomes } from "../src/rooms/runs/failure-class-model";
import { cancelParetoLine } from "../src/rooms/wall/morning";
import { insertReceipt } from "@lane-pilot/jev";
import { writerModelJudgment } from "../src/rooms/writer/writer-model-pick";
import { writerCandidates } from "@lane-pilot/models";

const NOW = 20 * 86_400_000;

function world() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "proj", "bb", "/repo");
  createTask(db, { id: "t1", runId: "run", kind: "bb", contract: { title: "task" } });
  return { bb, db };
}

const receipt = (db: never, subject: string, runId = "run") => insertReceipt(db, {
  judgment: "writer.model", version: 3, mode: "active", projectId: "proj", runId, subject,
  inputSha256: "x", inputChars: 1, questions: 1, status: "ok", answers: {}, decision: "haiku", decidedBy: "jev",
} as never);

describe("W31 rank 3a: the writer pick gets its outcome from the task", () => {
  it("an accepted task labels the pick agree, a dead one disagree, a running one stays unlabeled", () => {
    const { db } = world();
    const seen = (id: number) => (db.prepare("SELECT outcome FROM lane_pilot_jev_receipt WHERE id=?").get(id) as { outcome: string | null }).outcome;

    // accepted → agree
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    transitionAttempt(db, "a1", "spawn_requested"); transitionAttempt(db, "a1", "running", { threadId: "thr_1" });
    transitionAttempt(db, "a1", "accepted");
    const r1 = receipt(db as never, "t1");

    // blocked attempt + closed run → disagree
    createTask(db, { id: "t2", runId: "run", kind: "bb", contract: { title: "task2" } });
    createAttempt(db, { id: "a2", runId: "run", taskId: "t2" });
    transitionAttempt(db, "a2", "spawn_requested"); transitionAttempt(db, "a2", "running", { threadId: "thr_2" });
    transitionAttempt(db, "a2", "blocked");
    createRun(db, "run2", "proj", "bb", "/repo");
    db.prepare("UPDATE lane_pilot_run SET state='closed', closed_at=? WHERE id='run2'").run(NOW);
    createTask(db, { id: "t3", runId: "run2", kind: "bb", contract: { title: "task3" } });
    createAttempt(db, { id: "a3", runId: "run2", taskId: "t3" });
    transitionAttempt(db, "a3", "spawn_requested"); transitionAttempt(db, "a3", "running", { threadId: "thr_3" });
    transitionAttempt(db, "a3", "blocked");
    const r2 = receipt(db as never, "t3", "run2");

    // still running → unlabeled
    createTask(db, { id: "t4", runId: "run", kind: "bb", contract: { title: "task4" } });
    createAttempt(db, { id: "a4", runId: "run", taskId: "t4" });
    transitionAttempt(db, "a4", "spawn_requested"); transitionAttempt(db, "a4", "running", { threadId: "thr_4" });
    const r3 = receipt(db as never, "t4");

    const labeled = sweepWriterModelOutcomes(db as never);
    expect(labeled.map((row) => `${row.taskId}:${row.outcome}`)).toEqual(["t1:agree", "t3:disagree"]);
    expect(seen(r1)).toBe("agree");
    expect(seen(r2)).toBe("disagree");
    expect(seen(r3)).toBeNull();
    // A second sweep labels nothing twice.
    expect(sweepWriterModelOutcomes(db as never)).toEqual([]);
  });
});

describe("W31 rank 3b: the refusal share costs the pick", () => {
  const task = { title: "Fix the jump button", objective: "it sits under the thumb", owns_paths: ["src/Hud.luau"], expected_outputs: ["src/Hud.luau"], acceptance: ["lune run tests"] };
  const candidates = writerCandidates({});
  const thresholds = { min_p: 0.45, near: 0.12, hard_at: 0.66 };
  const hard = { complexity: { type: "score", score: 0, legend: {}, probabilities: { frontier: 1 } }, risk: { type: "score", score: 0, legend: {}, probabilities: { ordinary: 1 } } };
  const answers = (probs: Record<string, number>) => ({ writer: { type: "choice", probabilities: probs }, ...hard } as never);

  it("a pair refusing this project's attempts loses the near band; an unmeasured share does nothing", () => {
    const band = { "gpt-sol": 0.5, "gpt-astra": 0.44, composer: 0.06 };
    // No refusal data: gpt-sol keeps the pick.
    expect(writerModelJudgment.decide(answers(band), thresholds, { task, candidates, load: { "gpt-sol": { percent: 0, running: 0, refuseShare: null }, "gpt-astra": { percent: 0, running: 0, refuseShare: null } } }).decision).toEqual({ key: "gpt-sol" });
    // Every second attempt on gpt-sol refused here: the pick goes to gpt-astra.
    expect(writerModelJudgment.decide(answers(band), thresholds, { task, candidates, load: { "gpt-sol": { percent: 0, running: 0, refuseShare: 0.9 }, "gpt-astra": { percent: 0, running: 0, refuseShare: 0 } } }).decision).toEqual({ key: "gpt-astra" });
  });
});

describe("W31 rank 6: cancel codes", () => {
  it("the code list is closed and the first stamp wins (COALESCE)", () => {
    expect(CANCEL_CODES).toEqual(["owner_cancel", "superseded", "run_closed", "wrong_contract", "stuck", "duplicate", "reassign", "unknown"]);
    const { db } = world();
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    markCancelCode(db, "a1", "owner_cancel");
    markCancelCode(db, "a1", "stuck");
    expect((db.prepare("SELECT cancel_code FROM lane_pilot_attempt WHERE id='a1'").get() as { cancel_code: string }).cancel_code).toBe("owner_cancel");
  });

  it("cancelAttemptById hands the code to the queued-cancel path, missing means unknown", async () => {
    const { db } = world();
    createAttempt(db, { id: "a2", runId: "run", taskId: "t1" });
    const seen: string[] = [];
    const ctx = {
      bb: null, db,
      cancelQueuedAttempt: (attempt: { id: string }, why: string | undefined, code: string | undefined) => {
        seen.push(code ?? "none");
        transitionAttempt(db, attempt.id, "canceled", { reason: why });
        markCancelCode(db, attempt.id, (code as never) ?? "unknown");
        return { ok: true, state: "canceled", reason: null };
      },
    } as never;
    await cancelAttemptById(ctx, "a2", undefined, "why", "superseded");
    expect(seen).toEqual(["superseded"]);
    expect((db.prepare("SELECT cancel_code FROM lane_pilot_attempt WHERE id='a2'").get() as { cancel_code: string }).cancel_code).toBe("superseded");
  });

  it("the morning line reports the Pareto of cancel codes in the window", () => {
    const { db } = world();
    for (const [id, code] of [["c1", "owner_cancel"], ["c2", "owner_cancel"], ["c3", "stuck"], ["c4", null]] as const) {
      createAttempt(db, { id, runId: "run", taskId: "t1" });
      transitionAttempt(db, id, "spawn_requested"); transitionAttempt(db, id, "running", { threadId: `thr_${id}` });
      transitionAttempt(db, id, "cancel_requested"); transitionAttempt(db, id, "canceled");
      if (code) markCancelCode(db, id, code);
    }
    const line = cancelParetoLine(db as never);
    expect(line).toContain("owner_cancel 2");
    expect(line).toContain("stuck 1");
    expect(line).toContain("unknown 1");
    // Before the window: nothing.
    expect(cancelParetoLine(db as never, Date.now() + 2 * 86_400_000)).toBeNull();
  });
});

describe("W31 rank 11: queue waits", () => {
  const transitions = (id: string, rows: Array<[string, string, number]>) => rows.map(([from_state, to_state, at]) => ({ attempt_id: id, from_state, to_state, at }));

  it("sums the closed queued segments, re-queues included, and stays unsettled while queued", () => {
    expect(queueWaitMs(transitions("a", [["queued", "running", 5_000]]), { id: "a", state: "running", created_at: 0 })).toBe(5_000);
    expect(queueWaitMs([
      ...transitions("a", [["queued", "canceled", 4_000], ["canceled", "queued", 6_000], ["queued", "running", 9_000]]),
    ], { id: "a", state: "running", created_at: 0 })).toBe(7_000);
    expect(queueWaitMs(transitions("a", []), { id: "a", state: "queued", created_at: 0 })).toBe(-1);
  });

  it("the report carries queueWaitMs per attempt and p50/p99 in the summary, the run card reads the same waits", () => {
    const { db } = world();
    createAttempt(db, { id: "q1", runId: "run", taskId: "t1" });
    transitionAttempt(db, "q1", "spawn_requested"); transitionAttempt(db, "q1", "running", { threadId: "thr_q1" });
    transitionAttempt(db, "q1", "accepted");
    const wait = (db.prepare("SELECT at FROM lane_pilot_attempt_transition WHERE attempt_id='q1' AND to_state='running'").get() as { at: number }).at
      - (db.prepare("SELECT created_at FROM lane_pilot_attempt WHERE id='q1'").get() as { created_at: number }).created_at;

    const report = attemptMetrics(db as never, { projectId: "proj", days: 7 });
    const row = report.attempts.find((item) => item.attemptId === "q1")!;
    expect(row.queueWaitMs).toBe(wait);
    expect(report.summary.queueWait).toEqual({ samples: 1, p50Ms: wait, p99Ms: wait });
    expect(runQueueWaits(db as never, "run")).toEqual([wait]);
  });
});
