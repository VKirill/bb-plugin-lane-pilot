import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCore } from "../src/rooms/core/server/core";
import { createPhaseDriver } from "../src/rooms/phase/server/driver";
import { phaseRpc } from "../src/rooms/phase/server/rpc";
import { planSignature } from "../src/rooms/phase/logic";
import { listParts, savePhase } from "../src/rooms/phase/store";
import { createAttempt, createRun, createTask, openDatabase } from "../src/rooms/storage";
import { rpcContract } from "../src/rooms/contracts";

// SMA px_stop (2026-10-29 conformance audit, C-02): a stop ends the phase's work at hand before the phase. The phase used to turn
// «stopped» while its piece's writer went on running, and the screen had no stop of the phase at all, only «hold the wave».
async function fixture() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const calls: string[] = [];
  harness.sdk.stub("threads.stop" as never, async () => { calls.push("threads.stop"); return {}; });
  harness.sdk.stub("threads.send" as never, async () => ({}));
  harness.sdk.stub("threads.get" as never, async () => ({ status: "idle" }));
  harness.sdk.stub("threads.list" as never, async () => []);
  harness.sdk.stub("threads.listRunning" as never, async () => []);
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  db.prepare("UPDATE lane_pilot_run SET pm_thread_id=? WHERE id=?").run("thr_pm", "run1");
  const workflowEngine = { cancel: (id: string) => { calls.push(`workflow.cancel:${id}`); return true; } };
  const phases = createPhaseDriver(createCore(bb, db), { runBudgets: { get: () => undefined }, workflowEngine } as never).phases;
  const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "stop probe", goal: "deliver one piece", rails: true });
  const item = { id: "piece", title: "one piece", wave: 1, promise: { given: "g", when: "w", then: "t" }, task: { id: "piece", project_cwd: "/repo", owns_paths: ["src/**"], verification: [{ command: "npm test" }], acceptance: ["works"] } };
  createTask(db, { id: "piece", runId: "run1", kind: "bb", contract: item.task });
  createAttempt(db, { id: "att1", runId: "run1", taskId: "piece" });
  db.prepare("UPDATE lane_pilot_attempt SET state='running', thread_id='thr_writer' WHERE id='att1'").run();
  const sha = planSignature([item] as never, "ctx");
  savePhase(db, phase.id, { stage: "execution", runId: "run1", record: { ...phase.record, plan: { items: [item], sha, admittedSha: sha, contextSha: "ctx" }, execution: { issued: { piece: "piece" }, startedAt: 1 },
    auto: { kind: "plan", wfRunId: "wf-live", startedAt: 1 } } as never, at: 2 });
  return { db, phases, id: phase.id, calls };
}

describe("stopping a phase", () => {
  it("stops the running writer and the stage workflow before the phase turns stopped", async () => {
    const f = await fixture();
    expect(rpcContract.phase_control.input.safeParse({ phaseId: f.id, action: "stop", note: "wrong goal" }).success).toBe(true);
    await phaseRpc(f.phases).phase_control({ phaseId: f.id, action: "stop", note: "wrong goal" } as never);
    expect((f.db.prepare("SELECT state FROM lane_pilot_attempt WHERE id='att1'").get() as { state: string }).state).toBe("canceled");
    expect(f.calls).toEqual(["threads.stop", "workflow.cancel:wf-live"]);
    const phase = f.phases.list({})[0]!;
    expect(phase.state).toBe("stopped");
    expect(phase.record.auto).toBeUndefined();
    expect(listParts(f.db, f.id).map((part) => part.kind)).toEqual(expect.arrayContaining(["work_stopped", "stop"]));
  });

  it("a second stop finds nothing at work and still answers", async () => {
    const f = await fixture();
    await f.phases.stop({ phaseId: f.id, by: "owner" });
    const again = await f.phases.stop({ phaseId: f.id, by: "owner" });
    expect(again).toMatchObject({ canceled: [], unconfirmed: [] });
    expect(again.phase.state).toBe("stopped");
  });
});
