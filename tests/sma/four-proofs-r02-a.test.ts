import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { sha256Hex } from "@lane-pilot/kit";
import { describe, expect, it } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { createPhaseDriver } from "../phase-driver";
import { blindVerdict, pieceLines, planSignature, waveCleared, waveLines, issuable, type PhaseRecord, type PlanItem, type TaskFact } from "../../src/rooms/phase/logic";
import { getPhase, listParts, savePhase } from "../../src/rooms/phase/store";
import { createRunGoal } from "../../src/rooms/run-goal/server";
import { createAttempt, createRun, createTask, openDatabase, setRunThread, transitionAttempt } from "../../src/rooms/plugin-db";

// Region 2 · Batch graph, nodes n345..n382. The older [sma:…] tests of this region stay where they are
// (batch-graph-2, batch-gates-1, batch-stop-1, parity-b6-phase); this file adds what they left open: the nodes that had no test,
// and a result check where the older test looked only at the call.

const item = (id: string, over: Record<string, unknown> = {}, wave = 1): PlanItem => ({
  id, title: id, wave, promise: { given: "g", when: "w", then: `then-${id}` },
  task: { id, project_cwd: "/repo", owns_paths: [`src/${id}.ts`], verification: [{ command: `npm test -- ${id}` }], acceptance: [`acc-${id}`], ...over },
});
const fact = (taskId: string, over: Partial<TaskFact> = {}): TaskFact => ({ taskId, state: "accepted", planFact: "passed", verification: "passed", codeCritique: "passed", browserQa: "skipped", ...over });

function world() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.send", async () => ({}));
  harness.sdk.stub("threads.get", async () => ({ status: "idle" }));
  harness.sdk.stub("threads.list", async () => []);
  harness.sdk.stub("threads.stop", async () => ({}));
  harness.sdk.stub("threads.listRunning" as never, async () => []);
  bb.hosts.experimental_client = (() => ({ call: async (method: string) => {
    if (method === "runCommand") return { exitCode: 0, stdout: `${"a".repeat(64)}\n`, stderr: "" };
    if (method === "gitCommitDocs") return { commit: "c".repeat(40) };
    return {};
  } })) as never;
  const db = openDatabase(bb);
  createRun(db, "run1", "projA", "bb", "/repo");
  db.prepare("UPDATE lane_pilot_run SET writer_host_id='h', pm_thread_id='thr_pm' WHERE id='run1'").run();
  const dispatched: Array<Record<string, unknown>> = [];
  const phases = createPhaseDriver(createCore(bb, db), {
    runBudgets: { get: () => undefined },
    readWriterWorkspaceFile: async () => ({ sha256: sha256Hex("drawing"), sizeBytes: 7, content: "screens" }),
    // The task id the scheduler gives back is not the piece id: the phase must keep the one it was given.
    dispatchWriter: async (input: { task: Record<string, unknown> }) => {
      dispatched.push(input.task);
      const taskId = `${String(input.task.id)}-t1`;
      createTask(db, { id: taskId, runId: "run1", kind: "bb", contract: input.task });
      return { taskId, runId: "run1" };
    },
    regression: { run: async () => null }, rollback: { noteStopped: async () => ({ recorded: true }) },
    workflowEngine: { cancel: () => true, get: () => ({ status: "running" }), start: () => ({ runId: "wf", done: Promise.resolve() }) },
  } as unknown as Services).phases;
  return { db, phases, dispatched };
}

describe("batch graph r02", () => {
  it("[sma:bf_request] opening a phase writes the parent row with the owner's title and goal, in discussion, and hands no worker anything", async () => {
    const { db, phases } = world();
    const opened = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Skip empty cells", goal: "sums ignore empty cells in a column" });
    const row = db.prepare("SELECT title, goal, stage, state, pm_thread_id AS pm FROM lane_pilot_phase WHERE id=?").get(opened.id);
    expect(row).toEqual({ title: "Skip empty cells", goal: "sums ignore empty cells in a column", stage: "discussion", state: "active", pm: "thr_pm" });
    expect(listParts(db, opened.id).filter((part) => part.kind === "opened").map((part) => part.text)).toEqual([expect.stringContaining("Skip empty cells")]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_task").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_attempt").get() as { n: number }).n).toBe(0);
  });

  it("[sma:bf_design_ready] the drawing is stored under the hash of its files in path order, and a redrawn file is a new hash", async () => {
    const { db, phases } = world();
    const opened = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Screens", goal: "a screen" });
    savePhase(db, opened.id, { stage: "design", record: { ...opened.record, design: { decision: "needed", why: "screens" } }, at: 2 });
    const spec = `.agents/phases/${opened.id}/design/UI-SPEC.md`;
    const moved = await phases.drawing({ phaseId: opened.id, paths: [spec], designer: "design-lead", feasible: true, reviewer: "ui-review" });
    expect(moved.record.design?.drawing?.sha256).toBe(sha256Hex(`${spec}:${sha256Hex("drawing")}`));
    expect(moved.record.design?.drawing?.paths).toEqual([spec]);
    expect(listParts(db, opened.id).some((part) => part.kind === "drawing" && part.text.includes(spec))).toBe(true);
  });

  it("[sma:bi_pieces] a piece goes out once as a work with the piece's id, the phase keeps the id it was given back, and a later pass does not send it again", async () => {
    const { db, phases, dispatched } = world();
    const opened = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Two pieces", goal: "a then b" });
    const items = [item("a"), item("b", { depends_on: ["a"] }, 2)];
    const sha = planSignature(items, "ctx");
    savePhase(db, opened.id, { stage: "execution", runId: "run1", record: { ...opened.record, plan: { items, sha, admittedSha: sha, contextSha: "ctx" }, execution: { issued: {}, startedAt: 1 } } as PhaseRecord, at: 2 });
    const first = await phases.drive(getPhase(db, opened.id)!);
    expect(dispatched.map((task) => task.id)).toEqual(["a"]);
    expect(dispatched[0]).toMatchObject({ quality_mode: "full", owns_paths: ["src/a.ts"] });
    expect(first.record.execution?.issued).toEqual({ a: "a-t1" });
    expect(listParts(db, opened.id).filter((part) => part.kind === "issued").map((part) => part.text)).toEqual(["a → task a-t1 (wave 1)"]);
    await phases.drive(getPhase(db, opened.id)!);
    expect(dispatched.map((task) => task.id)).toEqual(["a"]);
  });

  it("[sma:bi_eligible] OUR rule, not the card's: an uncleared wave does not hold the next wave, only the pieces that depend on its pieces; the wave's clearance holds the phase exit", () => {
    // Card (SMA n365): «The next wave waits for this one's acceptance.» The owner's rule (ТЗ 4д.5, decision D7) starts a piece when
    // its own dependencies are accepted; the wave is an address for budget, stop and review, never a barrier.
    const items = [item("a"), item("b"), item("c", {}, 2), item("d", { depends_on: ["b"] }, 2)];
    const facts = new Map([["a", fact("a")], ["b", fact("b", { state: "running" })]]);
    expect(issuable(items, { a: "a", b: "b" }, facts).map((row) => row.id)).toEqual(["c"]);
    const lines = waveLines([items[0]!, items[1]!], facts);
    const record: PhaseRecord = { waveReview: true, execution: { issued: { a: "a", b: "b" }, waves: { "1": { packageSha: "p", lines, at: 1 } } } };
    // the lines of wave 1 do not hold (b is running) and its review was not given: not cleared, and still c goes
    expect(waveCleared(record, 1)).toBe(false);
    const ok = waveLines([items[0]!], new Map([["a", fact("a")]]));
    record.execution!.waves = { "1": { packageSha: "p", lines: ok, at: 1 } };
    expect(waveCleared(record, 1)).toBe(false);
    record.execution!.waves["1"]!.review = { state: "failed", by: "other", summary: "no", at: 2 };
    expect(waveCleared(record, 1)).toBe(false);
    record.execution!.waves["1"]!.review = { state: "passed", by: "other", summary: "yes", at: 3 };
    expect(waveCleared(record, 1)).toBe(true);
  });

  it("[sma:bw_compat] a finished run is checked together on the final main once, and the verdict the phase reads fails on a red composition", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.get", async () => ({ updatedAt: Date.now() }));
    harness.sdk.stub("threads.send", async () => undefined);
    const db = openDatabase(bb);
    createRun(db, "run1", "P", "bb", "/repo");
    setRunThread(db, "run1", "thr_pm");
    for (const id of ["t1", "t2"]) {
      createTask(db, { id, runId: "run1", kind: "bb", contract: {} as never });
      createAttempt(db, { id: `${id}-a1`, runId: "run1", taskId: id });
      transitionAttempt(db, `${id}-a1`, "spawn_requested");
      transitionAttempt(db, `${id}-a1`, "running", { threadId: `thr_${id}` });
      transitionAttempt(db, `${id}-a1`, "accepted");
    }
    createRun(db, "run2", "P", "bb", "/repo");
    createTask(db, { id: "t3", runId: "run2", kind: "bb", contract: {} as never });
    const asked: Array<Record<string, unknown>> = [];
    const regression = { run: async (options: Record<string, unknown>) => {
      asked.push(options);
      return { projects: [{ head: "f".repeat(40), tasks: [{ taskId: "t1", checks: [{ command: "check t1", state: "green" }] }, { taskId: "t2", checks: [{ command: "check t2", state: "red" }] }],
        findings: [{ taskId: "t2", command: "check t2", culpritCommit: "c".repeat(40), culpritTask: "t1" }] }] };
    } };
    const api = createRunGoal({ db, bb, log: () => undefined, isDisposed: () => false } as never, { regression } as never).runGoal;
    const swept = await api.sweep();
    // only the finished run is checked, on its project's main, every check of every accepted task together
    expect(swept.map((row) => [row.runId, row.state, row.headSha])).toEqual([["run1", "failed", "f".repeat(40)]]);
    expect(asked).toEqual([expect.objectContaining({ projectId: "P", runId: "run1", mode: "full" })]);
    expect(api.status("run2")).toBeNull();
    // the phase reads that verdict as a dedicated field: a red composition keeps its verdict failed and names the red check
    const goal = api.status("run1")!;
    const verdict = blindVerdict([item("t1"), item("t2")], new Map([["t1", fact("t1")], ["t2", fact("t2")]]), { state: goal.state, detail: "t2: check t2", headSha: goal.headSha }, 5);
    expect(verdict.state).toBe("failed");
    expect(verdict.detail).toContain("the run's goal check failed: t2: check t2");
    expect(verdict.mainSha).toBe("f".repeat(40));
  });

  it("[sma:bw_piece_land] a piece walks the task's acceptance states and lands only at accepted", () => {
    const piece = item("a");
    const walk = ["queued", "running", "checking", "accepted"].map((state) => pieceLines(piece, fact("a", { state }), undefined).find((line) => line.id === "landed")!);
    expect(walk.map((line) => line.ok)).toEqual([false, false, false, true]);
    expect(walk.map((line) => line.detail)).toEqual(["is queued", "is running", "is checking", "merged"]);
    const wave = waveLines([piece, item("b")], new Map([["a", fact("a")], ["b", fact("b", { state: "checking" })]])).find((line) => line.id === "landed")!;
    expect(wave).toMatchObject({ ok: false, detail: "landed fails: b" });
    expect(waveLines([piece], new Map([["a", fact("a")]])).find((line) => line.id === "landed")).toMatchObject({ ok: true, detail: "1 piece(s) hold landed" });
  });
});
