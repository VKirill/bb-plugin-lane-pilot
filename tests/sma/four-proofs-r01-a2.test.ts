// Region 1 (Task graph), batch a: the four proofs for the budget questions and the failure path (ac_budget_q, ac_pocket, ae_fail, ae_awaits,
// ae_exhausted, ae_parked, ag_parked). Results are read off the attempt rows, the owner items and the messages to the PM.
import { describe, expect, it, vi } from "vitest";
import { watchWriterRun } from "../../src/rooms/writer/server/watch-writer";
import { listOpenOwnerItemKeys } from "../../src/rooms/owner-waiting";
import { createAttempt, getAttempt, transitionAttempt } from "../../src/rooms/plugin-db";
import { observe, open, seedAttempt, startWorld } from "./r01-world-a";

describe("[sma:ac_budget_q] the stage budget question", () => {
  it("[sma:ac_budget_q] at four fifths of the task's appetite minutes the PM is asked once whether to extend them; before that nothing is said", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    try {
      const sends: Array<{ threadId: string; input: Array<{ text: string }> }> = [];
      let status = "active";
      const ctx = {
        bb: { sdk: { threads: { send: async (args: never) => { sends.push(args); }, stop: async () => undefined, events: { list: async () => [] }, list: async () => [], get: async () => ({ status }) } }, storage: { kv: { get: async () => null, set: async () => undefined } }, log: { warn() {}, info() {} } },
        db: open().db, state: { disposed: false }, log: () => undefined, getThreadBounded: async () => ({ status }),
      };
      const budget = { snapshot: () => ({ limits: {} }), check: () => ({ ok: true }), noteTokens: () => undefined };
      const run = watchWriterRun({ ctx: ctx as never, services: { runBudgetFor: () => budget } as never, facts: {}, providerFailed: () => null, holdProviderLimit: () => undefined,
        input: { projectId: "projA", runId: "run1", taskId: "t1", attemptId: "t1-a1", writerThreadId: "thr_w", pmThreadId: "thr_pm", task: { appetite: { minutes: 10 } } } as never });
      await vi.advanceTimersByTimeAsync(7 * 60_000);
      const askedBefore = sends.length;
      expect(sends).toEqual([]);
      await vi.advanceTimersByTimeAsync(1.5 * 60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sends).toHaveLength(1);
      observe("n165", { askedAt7min: askedBefore, askedAt9min: sends.length, to: sends[0]!.threadId, text: sends[0]!.input[0]!.text });
      expect(sends[0]!.threadId).toBe("thr_pm");
      expect(sends[0]!.input[0]!.text).toContain("Task t1 has spent 80% of its appetite (8/10 min)");
      expect(sends[0]!.input[0]!.text).toContain("lane_pilot_update_task");
      status = "idle";
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(run).resolves.toBeNull();
      expect(sends).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
});

describe("[sma:ac_pocket] the run's remainder ran out", () => {
  it("[sma:ac_pocket] when the run's token budget runs out between two attempts the next one is not started: it is blocked with the budget reason and one question goes to the owner with raise and finish actions", async () => {
    let spent = false;
    const budget = { check: () => spent ? { ok: false, exceeded: "maxTokens", used: 11, limit: 10, reason: "run budget exceeded" } : { ok: true }, noteAttempt: () => undefined, noteTokens: () => undefined, snapshot: () => ({ limits: {} }) };
    const w = startWorld({ budget, onFinish: () => { spent = true; }, finishes: [{ status: "validation_failed", reason: "verification failed (npm test): boom" }] });
    w.start();
    await vi.waitFor(() => expect(listOpenOwnerItemKeys(w.db, { kind: "budget_spent" })).toEqual(["run-budget:run1"]), { timeout: 10_000 });
    expect(w.spawned).toEqual(["T1-a1"]);
    const rows = w.attempts();
    expect(rows.at(-1)).toMatchObject({ state: "blocked", reason: "run_budget_exceeded:tokens" });
    const item = w.db.prepare("SELECT what, actions_json FROM lane_pilot_owner_item WHERE key='run-budget:run1'").get() as { what: string; actions_json: string };
    observe("n166", { spawned: w.spawned, lastState: rows.at(-1)!.state, lastReason: rows.at(-1)!.reason, what: item.what, actions: JSON.parse(item.actions_json).map((action: { id: string }) => action.id) });
    expect(item.what).toBe("Лимит прогона исчерпан: токены, потрачено 11 при лимите 10");
    expect(JSON.parse(item.actions_json).map((action: { id: string }) => action.id)).toEqual(["raise", "finish"]);
    await w.harness.lifecycle.dispose();
  });
});

describe("[sma:ae_fail] an attempt's failure is on its row", () => {
  it("[sma:ae_fail] a failed attempt keeps its reason and the structured failure code; an accepted attempt is not overwritten by a later failure", async () => {
    const { db, harness } = open();
    seedAttempt(db, "t1", [["spawn_requested"], ["running", ""]]);
    transitionAttempt(db, "t1-a1", "validation_failed", { reason: "verification failed (npm test): boom", failureCode: "verification_red" as never, checkName: "npm test" });
    expect(db.prepare("SELECT state, reason, failure_code, check_name FROM lane_pilot_attempt WHERE id='t1-a1'").get())
      .toEqual({ state: "validation_failed", reason: "verification failed (npm test): boom", failure_code: "verification_red", check_name: "npm test" });
    seedAttempt(db, "t2", [["spawn_requested"], ["running"], ["accepted"]]);
    // The row is settled: a failure written later is refused, the journal shows the refusal, the state stays accepted.
    expect(transitionAttempt(db, "t2-a1", "validation_failed", { reason: "late failure" })).toBe(false);
    expect(db.prepare("SELECT state, reason FROM lane_pilot_attempt WHERE id='t2-a1'").get()).toEqual({ state: "accepted", reason: null });
    expect(db.prepare("SELECT refused FROM lane_pilot_attempt_transition WHERE attempt_id='t2-a1' AND to_state='validation_failed'").get()).toEqual({ refused: 1 });
    await harness.lifecycle.dispose();
  });
});

describe("[sma:ae_exhausted] the queue's word «I will not re-issue again»", () => {
  it("[sma:ae_exhausted] a task whose two attempts both failed is blocked with «retry limit 2 exhausted» and its last reason, and no third writer starts", async () => {
    const w = startWorld({ finishes: [{ status: "validation_failed", reason: "owns_paths: src/x.ts is outside the contract" }] });
    // The task's first writer session (another thread) already failed on something else: this is its second attempt.
    w.start("T1", {}, (db) => {
      createAttempt(db, { id: "T1-p1", runId: "run1", taskId: "T1" });
      transitionAttempt(db, "T1-p1", "spawn_requested");
      transitionAttempt(db, "T1-p1", "running", { threadId: "thr_old" });
      transitionAttempt(db, "T1-p1", "validation_failed", { reason: "verification failed (npm test): first fault" });
    });
    await vi.waitFor(() => expect(w.attempts().at(-1)?.state).toBe("blocked"), { timeout: 20_000 }).catch((cause) => { console.log(JSON.stringify(w.attempts()), w.spawned); throw cause; });
    const rows = w.attempts();
    expect(rows.map((row) => [row.attempt_no, row.state])).toEqual([[1, "validation_failed"], [2, "blocked"]]);
    expect(rows[1]!.reason).toBe("retry limit 2 exhausted: owns_paths: src/x.ts is outside the contract");
    expect(w.spawned).toEqual(["T1-a1"]);
    await w.harness.lifecycle.dispose();
  });
});

describe("[sma:ae_parked] a failure that is not the task's waits for a person", () => {
  it("[sma:ae_parked] a dirty base checkout parks the task at once: one attempt, blocked with the reason, no retry is spent on it", async () => {
    const reason = "merge failed: your local changes would be overwritten by merge in src/a.ts";
    const w = startWorld({ finishes: [{ status: "validation_failed", reason }, { status: "accepted" }] });
    w.start();
    await vi.waitFor(() => expect(w.attempts().at(-1)?.state).toBe("blocked"), { timeout: 20_000 });
    observe("n178", { attempts: w.attempts().map((row) => [row.attempt_no, row.state, row.reason]), spawned: w.spawned, reason });
    expect(w.attempts().map((row) => [row.attempt_no, row.state, row.reason])).toEqual([[1, "blocked", reason]]);
    expect(w.spawned).toEqual(["T1-a1"]);
    await w.harness.lifecycle.dispose();
  });
});
