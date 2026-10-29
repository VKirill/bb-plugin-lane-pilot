import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import { PhaseRefusal, createPhaseDriver } from "../../src/rooms/phase/server/driver";
import { planSignature, sha256 } from "../../src/rooms/phase/logic";
import { listParts, savePhase } from "../../src/rooms/phase/store";
import { createAttempt, createRun, createTask, openDatabase } from "../../src/rooms/storage";

const item = {
  id: "piece", title: "one piece", wave: 1,
  promise: { given: "g", when: "w", then: "t" },
  task: { id: "piece", owns_paths: ["src/**"], verification: [{ command: "npm test" }], acceptance: ["works"] },
};

async function host(extra: Record<string, unknown> = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.stop" as never, async () => ({}));
  harness.sdk.stub("threads.send" as never, async () => ({}));
  harness.sdk.stub("threads.get" as never, async () => ({ status: "idle" }));
  harness.sdk.stub("threads.list" as never, async () => []);
  harness.sdk.stub("threads.listRunning" as never, async () => []);
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  db.prepare("UPDATE lane_pilot_run SET pm_thread_id=? WHERE id=?").run("thr_pm", "run1");
  const dispatched: string[] = [];
  const reverted: string[] = [];
  const phases = createPhaseDriver(createCore(bb, db), {
    runBudgets: { get: () => undefined },
    workflowEngine: { cancel: () => true, get: () => ({ status: "running" }), start: () => ({ runId: "wf", done: Promise.resolve() }) },
    dispatchWriter: async () => { dispatched.push("dispatch"); return { ok: true, taskId: "piece", runId: "run1" }; },
    rollback: { revert: async (taskId: string) => { reverted.push(taskId); return { state: "merged", ok: true }; } },
    readWriterWorkspaceFile: async () => ({ sha256: sha256("drawing"), sizeBytes: 7, content: "screens" }),
    ...extra,
  } as never).phases;
  const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "controls", goal: "one piece" });
  return { db, phases, id: phase.id, phase, dispatched, reverted };
}

describe("phase controls", () => {
  it("[sma:px_pause] [sma:cg_phase_pause] pauses the phase and issues none of its pieces", async () => {
    const f = await host();
    const sha = planSignature([item] as never, "ctx");
    savePhase(f.db, f.id, { stage: "execution", runId: "run1", record: { ...f.phase.record, plan: { items: [item], sha, admittedSha: sha, contextSha: "ctx" }, execution: { issued: {}, startedAt: 1 } } as never, at: 2 });
    const paused = f.phases.setState({ phaseId: f.id, state: "pause", by: "owner" });
    expect(paused.state).toBe("paused");
    const after = await f.phases.drive(f.phases.status(f.id).phase);
    expect(after.state).toBe("paused");
    expect(after.record.execution?.issued).toEqual({});
    expect(f.dispatched).toEqual([]);
  });

  it("[sma:p3_location] refuses a drawing written outside the phase design folder", async () => {
    const f = await host();
    savePhase(f.db, f.id, { stage: "design", record: { ...f.phase.record, design: { decision: "needed", why: "screens" } }, at: 2 });
    await expect(f.phases.drawing({
      phaseId: f.id, paths: ["docs/fig.png"], designer: "design-lead", feasible: true, reviewer: "ui-review",
    })).rejects.toBeInstanceOf(PhaseRefusal);
    await expect(f.phases.drawing({
      phaseId: f.id, paths: [`.agents/phases/${f.id}/design/../SECRET.md`], designer: "design-lead", feasible: true, reviewer: "ui-review",
    })).rejects.toThrow(/own folder/);
    expect(f.phases.status(f.id).phase.stage).toBe("design");
  });

  it("[sma:p3_confirm] confirms a reviewed drawing in the phase folder and moves the phase to execution", async () => {
    const f = await host();
    savePhase(f.db, f.id, { stage: "design", record: { ...f.phase.record, design: { decision: "needed", why: "screens" } }, at: 2 });
    const path = `.agents/phases/${f.id}/design/UI-SPEC.md`;
    const moved = await f.phases.drawing({ phaseId: f.id, paths: [path], designer: "design-lead", feasible: true, reviewer: "ui-review" });
    expect(moved.stage).toBe("execution");
    expect(moved.record.design?.confirmedAt).toEqual(expect.any(Number));
    expect(moved.record.design?.drawing?.paths).toEqual([path]);
    expect(moved.record.design?.drawing?.reviewer).not.toBe(moved.record.design?.drawing?.designer);
  });

  it("[sma:p4_plan_gate] [sma:pc_parent_guard] refuses to issue a plan that is not the one that was checked", async () => {
    const f = await host();
    const sha = planSignature([item] as never, "ctx");
    savePhase(f.db, f.id, { stage: "execution", runId: "run1", record: { ...f.phase.record, plan: { items: [item], sha, admittedSha: "e".repeat(64), contextSha: "ctx" }, execution: { issued: {}, startedAt: 1 } } as never, at: 2 });
    await expect(f.phases.drive(f.phases.status(f.id).phase)).rejects.toThrow(/plan changed since it was checked/);
    expect(f.dispatched).toEqual([]);
    expect(f.phases.status(f.id).phase.record.execution?.issued).toEqual({});
  });

  it("[sma:px_compensate] reverts only this phase's accepted pieces and records the revert's exit", async () => {
    const f = await host();
    createTask(f.db, { id: "task-done", runId: "run1", kind: "bb", contract: item.task });
    createTask(f.db, { id: "task-live", runId: "run1", kind: "bb", contract: { ...item.task, id: "live" } });
    createTask(f.db, { id: "task-other", runId: "run1", kind: "bb", contract: { ...item.task, id: "other" } });
    createAttempt(f.db, { id: "att-done", runId: "run1", taskId: "task-done" });
    createAttempt(f.db, { id: "att-live", runId: "run1", taskId: "task-live" });
    createAttempt(f.db, { id: "att-other", runId: "run1", taskId: "task-other" });
    f.db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='att-done'").run();
    f.db.prepare("UPDATE lane_pilot_attempt SET state='running' WHERE id='att-live'").run();
    f.db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='att-other'").run();
    const sha = planSignature([item] as never, "ctx");
    savePhase(f.db, f.id, { stage: "execution", runId: "run1", state: "closed", record: { ...f.phase.record, plan: { items: [item, { ...item, id: "live" }], sha, admittedSha: sha, contextSha: "ctx" }, execution: { issued: { piece: "task-done", live: "task-live" }, startedAt: 1 } } as never, at: 2 });
    const out = await f.phases.compensate({ phaseId: f.id, note: "undo the piece" });
    expect(f.reverted).toEqual(["task-done"]);
    expect(out.results).toEqual([{ taskId: "task-done", state: "merged" }]);
    expect(listParts(f.db, f.id).some((part) => part.kind === "compensated" && part.text.includes("task-done merged"))).toBe(true);
    expect(f.db.prepare("SELECT state FROM lane_pilot_attempt WHERE id='att-live'").get()).toMatchObject({ state: "running" });
  });
});
