import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../src/rooms/core/server/services";
import { createPhaseDriver } from "../../src/rooms/phase/server/driver";
import { planSignature, type PlanItem } from "../../src/rooms/phase/logic";
import { listParts, savePhase } from "../../src/rooms/phase/store";
import { createAttempt, createRun, createTask, openDatabase } from "../../src/rooms/storage";
import { createStability } from "../../src/rooms/stability/server/stability";

function driver(status = "idle") {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const sent: string[] = [];
  harness.sdk.stub("threads.send", async (input: { input: Array<{ text: string }> }) => { sent.push(input.input[0]!.text); return {}; });
  harness.sdk.stub("threads.get", async () => ({ status }));
  harness.sdk.stub("threads.list", async () => []);
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  const phases = createPhaseDriver(createCore(bb, db), { runBudgets: { get: () => undefined } } as unknown as Services).phases;
  return { phases, sent, db, bb };
}

describe("daemon tick", () => {
  it("[sma:dt_wave_holds] a wave stop is the phase row in the database, read by a new driver", async () => {
    const { phases, db, bb } = driver();
    const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hold", goal: "hold the wave" });
    await phases.stopWave({ phaseId: phase.id, by: "pm" });
    const again = createPhaseDriver(createCore(bb, db), { runBudgets: { get: () => undefined } } as unknown as Services).phases;
    expect(again.status(phase.id).phase.state).toBe("paused");
    expect(listParts(db, phase.id).some((part) => part.kind === "wave_stopped")).toBe(true);
  });

  it("[sma:dt_verify_waves] a wave whose pieces are all accepted is written once, with its lines", async () => {
    const { phases, db } = driver();
    const piece: PlanItem = { id: "hud", title: "Hud", wave: 1, promise: { given: "g", when: "w", then: "the bar stays" },
      task: { id: "hud", project_cwd: "/repo", owns_paths: ["src/**"], verification: [{ command: "npm test" }], acceptance: ["the bar stays"] } };
    createTask(db, { id: "hud", runId: "run1", kind: "bb", contract: piece.task });
    createAttempt(db, { id: "att1", runId: "run1", taskId: "hud" });
    db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='att1'").run();
    const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud", goal: "hud" });
    const sha = planSignature([piece], "ctx");
    savePhase(db, phase.id, { stage: "execution", runId: "run1", state: "active", record: { ...phase.record, plan: { items: [piece], contextSha: "ctx", sha, admittedSha: sha },
      execution: { issued: { hud: "hud" }, startedAt: 1 } } as never, at: 2 });
    await phases.drive(phases.list({ live: true })[0]!);
    const lines = listParts(db, phase.id).filter((part) => part.kind === "wave_in");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toContain("✓ pieces_accepted");
    await phases.drive(phases.list({ live: true })[0]!);
    expect(listParts(db, phase.id).filter((part) => part.kind === "wave_in")).toHaveLength(1);
  });

  it("[sma:dt_aging] the day count is computed from the last book part, and a second pass the same day adds none", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { phases, db } = driver();
      const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Stats", goal: "stats module" });
      await phases.tick();
      vi.setSystemTime(Date.now() + 4 * 86_400_000);
      await phases.tick();
      const aging = listParts(db, phase.id).filter((part) => part.kind === "aging");
      expect(aging.map((part) => part.text)).toEqual(["no movement for 4 day(s) at discussion"]);
      await phases.tick();
      expect(listParts(db, phase.id).filter((part) => part.kind === "aging")).toHaveLength(1);
    } finally { vi.useFakeTimers(); }
  });

  it.todo("[sma:dt_aging] agingSaidAt is stored, so the signal is not derived and kept nowhere");

  it("[sma:dt_call_waiting] a turn that needs the owner's word is a row, not only a PM message", async () => {
    const { phases, db, sent } = driver();
    const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Sums", goal: "sums" });
    savePhase(db, phase.id, { stage: "planning", record: { ...phase.record, ownerWords: true,
      plan: { items: [], sha: "s", contextSha: "c", critique: { decision: "approve", by: "critic" } } } as never, at: 2 });
    await phases.tick();
    const row = db.prepare("SELECT key, kind, source FROM lane_pilot_owner_item").get() as { key: string; kind: string; source: string };
    expect(row).toEqual({ key: `phase-word:${phase.id}:planning`, kind: "word", source: "phase" });
    expect(sent.some((text) => text.includes("owner's word"))).toBe(true);
  });

  it("[sma:dt_autoretry] a harness or machine fault is parked and re-queued; a product failure is not", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "proj", "cli", "/repo");
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id='pm', writer_workspace_path='/repo', state='running' WHERE id='run'").run();
    db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES('T1','run','bb','{}',1),('T2','run','bb','{}',1)").run();
    const resumed: string[] = [];
    const { stability } = createStability({ bb, isDisposed: () => false, db, log: () => undefined } as never, {
      activeWriterTasks: new Set<string>(),
      enqueueResumedWriter: async (_projectId: string, attempt: { task_id: string }) => { resumed.push(attempt.task_id); return true; },
    } as never);
    const base = { projectId: "proj", runId: "run", taskId: "T1", pmThreadId: "pm", state: "blocked" };
    expect(await stability.onTaskFailed({ ...base, reason: "acceptance rejected: the bar moved" })).toBe(false);
    expect(await stability.onTaskFailed({ ...base, reason: "spawn failed: helper down" })).toBe(true);
    expect(await stability.sweep(Date.now() + 3_600_000)).toEqual([]);
    expect(resumed).toEqual([]);
    expect(await stability.onTaskFailed({ ...base, taskId: "T2", reason: "ENOSPC: no space left" })).toBe(true);
    expect(await stability.sweep(Date.now() + 11 * 60_000)).toEqual(["T2"]);
    expect(resumed).toEqual(["T2"]);
  });
});
