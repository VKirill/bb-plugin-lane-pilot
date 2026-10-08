import { describe, expect, it } from "vitest";
import { complexityReport, noteOwnerQuestion, scanComplexity, scanPromises, spearman } from "../../src/rooms/learning/signals";
import { listSignals } from "../../src/rooms/learning/store";
import { NOW, database, jevWith } from "./helpers";

describe("other signals, as observations (T8)", () => {
  function seedAttempt(db: ReturnType<typeof database>, id: string, state = "accepted", at = NOW - 3_600_000, task = "t1") {
    db.prepare("INSERT OR IGNORE INTO lane_pilot_run (id, project_id, state, created_at, updated_at) VALUES ('run_1','proj_1','running',?,?)").run(at, at);
    db.prepare("INSERT OR IGNORE INTO lane_pilot_task (id, run_id, kind, contract_json, created_at) VALUES (?, 'run_1', 'bb', ?, ?)").run(task, JSON.stringify({ title: "Add a login button", objective: "Add it", owns_paths: ["src/login.ts"], acceptance: ["a button exists"] }), at);
    db.prepare("INSERT INTO lane_pilot_attempt (id, run_id, task_id, thread_id, state, created_at, updated_at, attempt_no) VALUES (?, 'run_1', ?, ?, ?, ?, ?, 1)").run(id, task, `thr_${id}`, state, at, at + 600_000);
  }

  it("reads the final answer of an accepted attempt once and records an unkept promise", async () => {
    const db = database();
    seedAttempt(db, "att_1");
    seedAttempt(db, "att_2", "accepted", NOW - 3_000_000, "t2");
    seedAttempt(db, "att_3", "blocked", NOW - 3_000_000, "t3");
    const { jev, calls } = jevWith(db, []);
    const answers: Record<string, string> = { thr_att_1: "Done. I added the button. TODO: the migration is left for later, not verified on staging.", thr_att_2: "Done and checked; the full suite is green and I attach the diff summary here." };
    const deps = { db, jev: () => jev, now: () => NOW, finalAnswer: async (thread: string) => answers[thread] ?? null };
    // The scripted Jev answers every Noul with 0.5, under the 0.6 line: read, but not recorded as a promise.
    expect(await scanPromises(deps)).toEqual({ read: 2, found: 0 });
    expect(listSignals(db, { kind: "unkept_promise" }).map((row) => row.ref).sort()).toEqual(["att_1", "att_2"]);
    expect(calls.every((call) => call.state.final_answer.length > 0)).toBe(true);
    expect(await scanPromises(deps)).toEqual({ read: 0, found: 0 });
  });

  it("records a hit with a short masked excerpt when Jev is sure", async () => {
    const db = database();
    seedAttempt(db, "att_1");
    const { jev } = jevWith(db, []);
    const sure = { ...jev, judge: async (j: unknown, input: unknown, ctx: unknown) => ({ by: "jev" as const, decision: 0.9, receiptId: null, answers: {} }) } as never;
    const result = await scanPromises({ db, jev: () => sure, now: () => NOW, finalAnswer: async () => "Done, owner@example.com. TODO: the migration is left for later, not verified on staging at all." });
    expect(result).toEqual({ read: 1, found: 1 });
    const [signal] = listSignals(db, { kind: "unkept_promise" });
    expect(signal).toMatchObject({ ref: "att_1", p: 0.9 });
    expect(signal!.detail).toContain("[email]");
  });

  it("judges a question to the owner at once and keeps only a masked excerpt of a routable one", async () => {
    const db = database();
    const { jev } = jevWith(db, []);
    const sure = { ...jev, judge: async () => ({ by: "jev" as const, decision: 0.8, receiptId: null, answers: {} }) } as never;
    expect(await noteOwnerQuestion({ db, jev: () => sure, now: () => NOW }, { projectId: "proj_1", threadId: "thr_pm", question: "Which wording for the button, ask me at a@b.io?" })).toBe(0.8);
    const [signal] = listSignals(db, { kind: "owner_question" });
    expect(signal).toMatchObject({ projectId: "proj_1", p: 0.8 });
    expect(signal!.detail).toContain("[email]");
    expect(await noteOwnerQuestion({ db, jev: () => null, now: () => NOW }, { projectId: "proj_1", threadId: "thr_pm", question: "x" })).toBeNull();
  });

  it("sizes the contracts of finished tasks and reports whether the size predicts the effort", async () => {
    const db = database();
    seedAttempt(db, "att_1", "accepted", NOW - 3_600_000, "t1");
    seedAttempt(db, "att_2", "accepted", NOW - 3_000_000, "t2");
    const sizes: Record<string, number> = { t1: 1, t2: 3 };
    const jev = { enabled: () => true, judge: async (_j: unknown, input: { contract: { title?: string } }, ctx: { subject: string }) => ({ by: "jev" as const, decision: sizes[ctx.subject] ?? 2, receiptId: null, answers: {} }) } as never;
    expect(await scanComplexity({ db, jev: () => jev, now: () => NOW })).toEqual({ read: 2 });
    expect(await scanComplexity({ db, jev: () => jev, now: () => NOW })).toEqual({ read: 0 });
    const report = complexityReport(db);
    expect(report.tasks).toBe(2);
    expect(report.bySize.map((row) => [row.size, row.tasks])).toEqual([[1, 1], [3, 1]]);
    expect(report.bySize[0]).toMatchObject({ meanAttempts: 1, meanMinutes: 10 });
    expect(report.rankCorrelationWithAttempts).toBeNull();
  });

  it("computes a rank correlation", () => {
    expect(spearman([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])).toBe(1);
    expect(spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1])).toBe(-1);
    expect(spearman([1, 1, 1], [1, 2, 3])).toBe(0);
  });

  it("does nothing without Jev", async () => {
    const db = database();
    seedAttempt(db, "att_1");
    expect(await scanPromises({ db, jev: () => null, finalAnswer: async () => "x".repeat(100) })).toEqual({ read: 0, found: 0 });
    expect(await scanComplexity({ db, jev: () => null })).toEqual({ read: 0 });
  });
});
