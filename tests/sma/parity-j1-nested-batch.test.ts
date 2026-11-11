import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { createPhaseDriver } from "../phase-driver";
import { planSignature, type PlanItem } from "../../src/rooms/phase/logic";
import { getPhase, listParts, savePhase } from "../../src/rooms/phase/store";
import { closeRun, createRun, openDatabase } from "../../src/rooms/plugin-db";

const OFF = { branch: "phase/test", trees: {}, off: "no phase branch in this test" };

const piece: PlanItem = {
  id: "T1", title: "Skeleton", wave: 1,
  promise: { given: "g", when: "w", then: "t" },
  task: { id: "T1", owns_paths: ["src/**"], verification: [{ command: "npm test" }], acceptance: ["npm test passes"] },
};

async function host() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.send", async () => ({}));
  harness.sdk.stub("threads.get", async () => ({ status: "idle", environmentId: "env_pm" }));
  harness.sdk.stub("environments.get", async () => ({ path: "/work/bot", hostId: "h1" }));
  const db = openDatabase(bb);
  const sent: Array<Record<string, unknown>> = [];
  const services = {
    dispatchWriter: async (input: { task: Record<string, unknown> }) => { sent.push(input.task); return { taskId: input.task.id, runId: "run1" }; },
    runBudgets: { get: () => undefined },
  } as unknown as Services;
  const phases = createPhaseDriver(createCore(bb, db), services).phases;
  return { db, phases, sent };
}

/** Opens a phase in execution, bound to `runId`, its plan admitted. */
async function phaseOnRun(phases: Awaited<ReturnType<typeof host>>["phases"], db: ReturnType<typeof openDatabase>, runId: string | null) {
  const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Bot", goal: "a bot" });
  const sha = planSignature([piece], "ctx");
  savePhase(db, phase.id, { stage: "execution", runId, record: { ...phase.record, candidate: OFF, plan: { items: [piece], contextSha: "ctx", sha, admittedSha: sha, critique: { decision: "approve", by: "critic" } } } as never, at: 2 });
  return phase.id;
}

describe("plan as a nested batch [sma:p4_nested_batch]", () => {
  it("closes a phase executing its plan in a run when a person closes that run, naming the run", async () => {
    const { db, phases, sent } = await host();
    createRun(db, "run1", "projA");
    const phaseId = await phaseOnRun(phases, db, "run1");
    closeRun(db, "run1", "cli");
    await phases.tick();
    const after = getPhase(db, phaseId)!;
    expect(after.state).toBe("closed");
    expect(after.stage).toBe("closed");
    expect(after.record.closing?.words).toBe(`batch closed: run1`);
    // The reason is in the phase book, where `bb lane-pilot phase` shows it.
    expect(listParts(db, phaseId).some((part) => part.text.includes("batch closed: run1"))).toBe(true);
    // The closed phase issues nothing further.
    await phases.tick();
    expect(sent).toHaveLength(0);
  });

  it("leaves a phase alone while its run stays open", async () => {
    const { db, phases } = await host();
    createRun(db, "run1", "projA");
    const phaseId = await phaseOnRun(phases, db, "run1");
    await phases.tick();
    expect(getPhase(db, phaseId)!.state).not.toBe("closed");
  });

  it("closes only the phases bound to the closed run, not another run's", async () => {
    const { db, phases } = await host();
    createRun(db, "run1", "projA");
    createRun(db, "run2", "projA");
    const bound = await phaseOnRun(phases, db, "run1");
    const other = await phaseOnRun(phases, db, "run2");
    closeRun(db, "run1", "rpc");
    await phases.tick();
    expect(getPhase(db, bound)!.state).toBe("closed");
    expect(getPhase(db, other)!.state).not.toBe("closed");
  });

  it("the hub's own cleaning of an idle run (sweep, ttl) ends nobody's plan, and a paused phase or one not in execution is left to its owner", async () => {
    const { db, phases } = await host();
    for (const run of ["run1", "run2", "run3", "run4"]) createRun(db, run, "projA");
    const swept = await phaseOnRun(phases, db, "run1");
    const expired = await phaseOnRun(phases, db, "run2");
    const paused = await phaseOnRun(phases, db, "run3");
    savePhase(db, paused, { state: "paused", at: 3 });
    const planning = await phaseOnRun(phases, db, "run4");
    savePhase(db, planning, { stage: "planning", at: 3 });
    closeRun(db, "run1", "sweep");
    closeRun(db, "run2", "ttl");
    closeRun(db, "run3", "cli");
    closeRun(db, "run4", "cli");
    await phases.tick();
    for (const id of [swept, expired, paused, planning]) expect(getPhase(db, id)!.state, id).not.toBe("closed");
    expect(getPhase(db, paused)!.state).toBe("paused");
  });

  it("never reopens a phase the batch close ended", async () => {
    const { db, phases } = await host();
    createRun(db, "run1", "projA");
    const phaseId = await phaseOnRun(phases, db, "run1");
    closeRun(db, "run1", "cli");
    await phases.tick();
    await phases.tick();
    expect(getPhase(db, phaseId)!.state).toBe("closed");
  });
});
