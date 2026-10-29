import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import { PhaseRefusal, createPhaseDriver } from "../../src/rooms/phase/server/driver";
import { planSignature } from "../../src/rooms/phase/logic";
import { listParts, savePhase } from "../../src/rooms/phase/store";
import { createAttempt, createRun, createTask, openDatabase } from "../../src/rooms/storage";

const item = (id: string) => ({
  id, title: id, wave: 1, promise: { given: "g", when: "w", then: "t" },
  task: { id, project_cwd: "/repo", owns_paths: ["src/**"], verification: [{ command: "npm test" }], acceptance: ["works"] },
});

async function openPhase() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.stop" as never, async () => ({}));
  harness.sdk.stub("threads.send" as never, async () => ({}));
  harness.sdk.stub("threads.get" as never, async () => ({ status: "idle" }));
  harness.sdk.stub("threads.listRunning" as never, async () => []);
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  const phases = createPhaseDriver(createCore(bb, db), { runBudgets: { get: () => undefined }, workflowEngine: { cancel: () => true } } as never).phases;
  const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "batch stop", goal: "deliver the pieces", rails: true });
  return { db, phases, phase };
}

describe("batch stop", () => {
  it("[sma:bi_skipped] an unissued piece leaves the plan and is named; an issued piece is not withdrawn", async () => {
    const { db, phases, phase } = await openPhase();
    const keep = item("keep");
    const gone = item("gone");
    const issued = item("issued");
    const sha = planSignature([keep, gone, issued] as never, "ctx");
    savePhase(db, phase.id, { stage: "execution", record: { ...phase.record, plan: { items: [keep, gone, issued], sha, admittedSha: sha, contextSha: "ctx" }, execution: { issued: { issued: "issued" }, startedAt: 1 } } as never, at: 2 });
    expect(() => phases.withdraw({ phaseId: phase.id, pieces: ["issued"], note: "too late", by: "pm" })).toThrow(PhaseRefusal);
    const after = phases.withdraw({ phaseId: phase.id, pieces: ["gone"], note: "out of scope", by: "pm" });
    expect(after.record.plan?.items.map((row) => row.id)).toEqual(["keep", "issued"]);
    expect(after.record.scope?.withdrawn).toEqual(["gone"]);
    expect(listParts(db, phase.id).some((part) => part.kind === "scope_withdrawn" && part.text.includes("gone"))).toBe(true);
    expect(listParts(db, phase.id).some((part) => part.text.includes("keep withdrawn"))).toBe(false);
  });

  it("[sma:bi_cancelled] [sma:bi_wave_hold] stopping takes the open piece and leaves the landed one; a wave hold takes only the queued piece", async () => {
    const { db, phases, phase } = await openPhase();
    for (const id of ["landed", "open", "queued"]) createTask(db, { id, runId: "run1", kind: "bb", contract: item(id).task });
    createAttempt(db, { id: "landed-a", runId: "run1", taskId: "landed" });
    createAttempt(db, { id: "open-a", runId: "run1", taskId: "open" });
    createAttempt(db, { id: "queued-a", runId: "run1", taskId: "queued" });
    db.prepare("UPDATE lane_pilot_attempt SET state='accepted', thread_id='thr_landed' WHERE id='landed-a'").run();
    db.prepare("UPDATE lane_pilot_attempt SET state='running', thread_id='thr_open' WHERE id='open-a'").run();
    db.prepare("UPDATE lane_pilot_attempt SET state='queued' WHERE id='queued-a'").run();
    const pieces = ["landed", "open", "queued"].map(item);
    const sha = planSignature(pieces as never, "ctx");
    savePhase(db, phase.id, { stage: "execution", runId: "run1", record: { ...phase.record, plan: { items: pieces, sha, admittedSha: sha, contextSha: "ctx" }, execution: { issued: { landed: "landed", open: "open", queued: "queued" }, startedAt: 1 } } as never, at: 2 });
    const held = await phases.stopWave({ phaseId: phase.id, by: "pm" });
    expect(held.canceled).toEqual(["queued"]);
    expect(held.phase.state).toBe("paused");
    expect((db.prepare("SELECT state FROM lane_pilot_attempt WHERE id='landed-a'").get() as { state: string }).state).toBe("accepted");
    expect((db.prepare("SELECT state FROM lane_pilot_attempt WHERE id='open-a'").get() as { state: string }).state).toBe("running");
    db.prepare("UPDATE lane_pilot_phase SET state='active' WHERE id=?").run(phase.id);
    const stopped = await phases.stop({ phaseId: phase.id, by: "owner", words: "abandon the batch" });
    expect(stopped.unconfirmed, JSON.stringify(stopped)).toEqual([]);
    expect(stopped.canceled).toEqual(["open"]);
    expect(stopped.phase.state).toBe("stopped");
    expect((db.prepare("SELECT state FROM lane_pilot_attempt WHERE id='landed-a'").get() as { state: string }).state).toBe("accepted");
    expect((db.prepare("SELECT state FROM lane_pilot_attempt WHERE id='open-a'").get() as { state: string }).state).toBe("canceled");
  });

  it.todo("[sma:bi_decide] a broken piece has exactly three ways out — skip, retry, cancel — and no fourth"); // deferral:dfr_seed_skip_sma_gaps
});
