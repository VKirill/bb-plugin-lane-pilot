import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createAttempt, createRun, createTask, openDatabase, transitionAttempt } from "../src/rooms/plugin-db";
import { queueWaitMs } from "../src/rooms/usage/models/attempt-metrics";
import { attemptMetrics, runQueueWaits } from "../src/rooms/usage/server";
import { markCancelCode, cancelAttemptById, CANCEL_CODES } from "../src/rooms/runs/server";
import { rpcRuns } from "../src/rooms/contracts/rpc-runs";

function world() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "proj", "bb", "/repo");
  createTask(db, { id: "t1", runId: "run", kind: "bb", contract: { title: "task" } });
  return { bb, db };
}

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
    const wait = (db.prepare("SELECT at FROM lane_pilot_attempt_transition WHERE attempt_id='q1' AND from_state='queued'").get() as { at: number }).at
      - (db.prepare("SELECT created_at FROM lane_pilot_attempt WHERE id='q1'").get() as { created_at: number }).created_at;

    const report = attemptMetrics(db as never, { projectId: "proj", days: 7 });
    const row = report.attempts.find((item) => item.attemptId === "q1")!;
    expect(row.queueWaitMs).toBe(wait);
    expect(report.summary.queueWait).toEqual({ samples: 1, p50Ms: wait, p99Ms: wait });
    expect(runQueueWaits(db as never, "run")).toEqual([wait]);
  });
});

describe("W31 run card contract", () => {
  // 0.1.396–0.1.398: the handler returned queueWait, the contract did not know it, and every run card failed validation on the hub.
  it("the run card output contract accepts the queue waits the handler returns", () => {
    expect(rpcRuns.get_run_card.output.safeParse({ runId: "r", state: "running", closed: false, tasks: [], queueWait: { samples: 2, p50Ms: 5_000, p99Ms: null } }).success).toBe(true);
  });
});
