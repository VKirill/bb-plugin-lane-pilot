import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import { PhaseRefusal, createPhaseDriver } from "../../src/rooms/phase/server/driver";
import { contextSignature, designDecision, executionGate, issuable, pieceProblems, pieceSha, planSignature, type PhaseRecord, type PlanItem, type TaskFact } from "../../src/rooms/phase/logic";
import { getPhase, listParts, savePhase } from "../../src/rooms/phase/store";
import { pauseRun } from "../../src/rooms/runs/server/runs-pause";
import { createAttempt, createRun, createTask, openDatabase } from "../../src/rooms/storage";

const piece = (id: string, wave = 1): PlanItem => ({
  id, title: id, wave, promise: { given: "a cell", when: "the sum runs", then: "the cell is skipped" },
  task: { id, owns_paths: [`src/${id}.ts`], verification: [{ command: `npm test -- ${id}` }] },
});

const fact = (id: string, state = "accepted"): TaskFact => ({
  taskId: id, state, planFact: "passed", verification: "passed", codeCritique: "passed",
});

async function host() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.stop" as never, async () => ({}));
  harness.sdk.stub("threads.send" as never, async () => ({}));
  harness.sdk.stub("threads.get" as never, async () => ({ status: "idle" }));
  harness.sdk.stub("threads.listRunning" as never, async () => []);
  const db = openDatabase(bb);
  const phases = createPhaseDriver(createCore(bb, db), { runBudgets: { get: () => undefined }, runGoal: { check: async () => null }, workflowEngine: { cancel: () => true } } as never).phases;
  return { bb, db, phases };
}

describe("batch graph", () => {
  it("[sma:bf_draft] a piece with no promise, no files or no check is refused by name", () => {
    const bare = piece("a");
    bare.promise = { given: "", when: "runs", then: "skips" };
    bare.task = { id: "other" };
    const why = pieceProblems(bare).join(" ");
    expect(why).toContain("a: the task id must equal the piece id");
    expect(why).toContain("a: the promise has no «given»");
    expect(why).toContain("a: no owns_paths");
    expect(why).toContain("a: no verification command");
    expect(pieceProblems(piece("a"))).toEqual([]);
  });

  it("[sma:bf_design_work] one drawing decision names every screen piece, not a drawing per piece", () => {
    const decision = designDecision([
      piece("card", 1),
      piece("row", 2),
    ].map((item, index) => index === 0 ? item : { ...item, task: { ...item.task, owns_paths: ["src/ui/Row.tsx"] } }));
    const both = designDecision([
      { ...piece("card"), task: { ...piece("card").task, owns_paths: ["src/ui/Card.tsx"] } },
      { ...piece("row"), task: { ...piece("row").task, owns_paths: ["src/ui/Row.tsx"] } },
    ]);
    expect(both.decision).toBe("needed");
    expect(both.why).toContain("card");
    expect(both.why).toContain("row");
    expect(decision.decision).toBe("needed");
    expect(decision.why).toContain("row");
    expect(decision.why).not.toMatch(/card/);
  });

  it("[sma:bi_held] [sma:bi_pieces] a later piece stays out while an earlier one is unissued, and an issued piece is not put back when it blocks", () => {
    const items = [piece("a", 1), piece("b", 2)];
    expect(issuable(items, {}, new Map()).map((item) => item.id)).toEqual(["a"]);
    const blocked = new Map([["a", fact("a", "blocked")]]);
    expect(issuable(items, { a: "task-a" }, blocked, () => true, { a: pieceSha(items[0]!) })).toEqual([]);
  });

  it("[sma:bw_ready] [sma:bw_promise_due] the gate stays shut, naming the piece, until the last wave is accepted", () => {
    const items = [piece("a", 1), piece("b", 2)];
    const early = executionGate(items, { a: "task-a" }, new Map([["a", fact("a")]]));
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.why.join(" ")).toContain("b is not issued yet");
    const running = executionGate(items, { a: "task-a", b: "task-b" }, new Map([["a", fact("a")], ["b", fact("b", "running")]]));
    expect(running.ok).toBe(false);
    if (!running.ok) expect(running.why.join(" ")).toContain("b is running");
    expect(executionGate(items, { a: "task-a", b: "task-b" }, new Map([["a", fact("a")], ["b", fact("b")]])).ok).toBe(true);
  });

  it("[sma:bf_request] [sma:bf_suggest] opening a phase writes the request and no worker task; a submitted plan still leaves the queue empty", async () => {
    const { db, phases } = await host();
    createRun(db, "run1", "projA");
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id=? WHERE id=?").run("thr_pm", "run1");
    const opened = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Sum", goal: "sums skip empty cells" });
    expect(opened.stage).toBe("discussion");
    expect(opened.record.plan).toBeUndefined();
    expect((db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_task").get() as { n: number }).n).toBe(0);
    const docs = [{ path: "docs/CONTEXT.md", sha256: "a".repeat(64), bytes: 20 }];
    const context = { docs, sha: contextSignature(docs), signedAt: 1, risks: { value: "missed totals", usability: "none", feasibility: "none", viability: "none" }, appetite: "one day", noGos: ["none"] };
    const before = opened.edition;
    savePhase(db, opened.id, { stage: "planning", record: { ...opened.record, context } as PhaseRecord, at: 2 });
    const submitted = phases.plan({ phaseId: opened.id, items: [piece("a")], by: "pm" });
    expect(submitted.record.plan?.items.map((item) => item.id)).toEqual(["a"]);
    expect(submitted.record.plan?.sha).toBe(planSignature([piece("a")], context.sha));
    expect(submitted.edition).toBeGreaterThan(before);
    expect((db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_attempt").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_task").get() as { n: number }).n).toBe(0);
  });

  it("[sma:bf_contract] [sma:bi_key] a composition edit raises the edition and the piece names are still on the row; a pause does not raise it", async () => {
    const { bb, db, phases } = await host();
    const opened = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Sum", goal: "sums" });
    const docs = [{ path: "docs/CONTEXT.md", sha256: "b".repeat(64), bytes: 20 }];
    const context = { docs, sha: contextSignature(docs), signedAt: 1, risks: { value: "v", usability: "none", feasibility: "none", viability: "none" }, appetite: "one day", noGos: ["none"] };
    savePhase(db, opened.id, { stage: "planning", record: { ...opened.record, context } as PhaseRecord, at: 2 });
    const submitted = phases.plan({ phaseId: opened.id, items: [piece("keep")], by: "pm" });
    const paused = phases.setState({ phaseId: opened.id, state: "pause", by: "pm" });
    expect(paused.edition).toBe(submitted.edition);
    expect(paused.state).toBe("paused");
    const again = getPhase(db, opened.id);
    expect(again?.record.plan?.items.map((item) => item.id)).toEqual(["keep"]);
    expect(again?.edition).toBe(submitted.edition);
    expect(bb.storage.database().prepare("SELECT title FROM lane_pilot_phase WHERE id=?").get(opened.id)).toMatchObject({ title: "Sum" });
  });

  it("[sma:bw_close] [sma:bw_verify] a finished wave is written to the book once, and a review before that is refused", async () => {
    const { db, phases } = await host();
    createRun(db, "run1", "projA");
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id=? WHERE id=?").run("thr_pm", "run1");
    const opened = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Wave", goal: "land the piece" });
    const item = piece("a");
    createTask(db, { id: "a", runId: "run1", kind: "bb", contract: item.task });
    createAttempt(db, { id: "att", runId: "run1", taskId: "a" });
    db.prepare("UPDATE lane_pilot_attempt SET state='accepted', thread_id='thr_w' WHERE id='att'").run();
    const sha = planSignature([item], "ctx");
    savePhase(db, opened.id, {
      stage: "execution", runId: "run1",
      record: { ...opened.record, plan: { items: [item], sha, admittedSha: sha, contextSha: "ctx" }, execution: { issued: { a: "a" }, issuedSha: { a: pieceSha(item) }, startedAt: 1 } } as PhaseRecord,
      at: 3,
    });
    expect(() => phases.waveReview({ phaseId: opened.id, wave: 1, state: "passed", by: "other-model", summary: "clean" })).toThrow(PhaseRefusal);
    const driven = await phases.drive(phases.status(opened.id).phase);
    const marks = listParts(db, opened.id).filter((part) => part.kind === "wave_in");
    expect(marks).toHaveLength(1);
    expect(marks[0]!.text).toContain("wave 1 in");
    expect(driven.record.execution?.waves?.["1"]?.lines.every((line) => line.ok)).toBe(true);
    const reviewed = phases.waveReview({ phaseId: opened.id, wave: 1, state: "passed", by: "other-model", summary: "the package matches" });
    expect(reviewed.record.execution?.waves?.["1"]?.review).toMatchObject({ state: "passed", by: "other-model" });
    await phases.drive(reviewed);
    expect(listParts(db, opened.id).filter((part) => part.kind === "wave_in")).toHaveLength(1);
  });

  it("[sma:bi_pause] pausing the named run holds its queued piece and leaves a running piece listed as still at work", async () => {
    const { bb, db } = await host();
    createRun(db, "run1", "projA");
    createRun(db, "run2", "projA");
    createTask(db, { id: "queued", runId: "run1", kind: "bb", contract: { id: "queued" } });
    createTask(db, { id: "running", runId: "run1", kind: "bb", contract: { id: "running" } });
    createAttempt(db, { id: "q", runId: "run1", taskId: "queued" });
    createAttempt(db, { id: "r", runId: "run1", taskId: "running" });
    db.prepare("UPDATE lane_pilot_attempt SET state='running', thread_id='thr_r' WHERE id='r'").run();
    const core = createCore(bb, db);
    const paused = await pauseRun(core, "run1", "pause");
    expect(paused.paused).toBe(true);
    expect(paused.waiting.map((row) => row.taskId)).toEqual(["queued"]);
    expect(paused.running.map((row) => row.taskId)).toEqual(["running"]);
    const other = await pauseRun(core, "run2", "status");
    expect(other.paused).toBe(false);
    const again = await pauseRun(core, "run1", "status");
    expect(again.paused).toBe(true);
    expect(again.changed).toBe(false);
  });

  it.todo("[sma:bi_pause] a pause is refused when the target run is not this batch"); // deferral:dfr_seed_skip_sma_gaps

  it.todo("[sma:bi_revise] trimming the scope revokes the earlier issue permission"); // deferral:dfr_seed_skip_sma_gaps
});
