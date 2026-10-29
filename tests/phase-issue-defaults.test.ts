import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCore } from "../src/rooms/core/server/core";
import type { Services } from "../src/rooms/core/server/services";
import { createPhaseDriver } from "../src/rooms/phase/server/driver";
import { planSignature, type PlanItem } from "../src/rooms/phase/logic";
import { savePhase } from "../src/rooms/phase/store";
import { createRun, openDatabase } from "../src/rooms/storage";

// Live ph_86fd9d3fab (2026-10-27): the planner's pieces had no project_cwd and no objective; task-v2 refused every one and the PM had
// to return the phase to planning to add them by hand. The machine knows both: the PM's checkout and the piece's own promise.
describe("issuing a phase piece", () => {
  it("fills the folder from the PM's checkout and the objective from the piece's promise when the planner left them out", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.send", async () => ({}));
    harness.sdk.stub("threads.get", async () => ({ status: "active", environmentId: "env_pm" }));
    harness.sdk.stub("environments.get", async () => ({ path: "/work/bot", hostId: "h1" }));
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    const sent: Array<Record<string, unknown>> = [];
    const services = { dispatchWriter: async (input: { task: Record<string, unknown> }) => { sent.push(input.task); return { taskId: input.task.id, runId: "run1" }; }, runBudgets: { get: () => undefined } } as unknown as Services;
    const phases = createPhaseDriver(createCore(bb, db), services).phases;
    const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Bot", goal: "a bot" });
    const bare: PlanItem = { id: "T1", title: "Project skeleton", wave: 1, promise: { given: "an empty repo", when: "npm test runs", then: "it passes" },
      task: { id: "T1", owns_paths: ["src/**"], verification: [{ command: "npm test" }], acceptance: ["npm test passes"] } };
    const own: PlanItem = { ...bare, id: "T2", task: { ...bare.task, id: "T2", project_cwd: "/elsewhere", objective: "its own" } };
    const items = [bare, own];
    const sha = planSignature(items, "ctx");
    savePhase(db, phase.id, { stage: "execution", runId: "run1", record: { ...phase.record, plan: { items, contextSha: "ctx", sha, admittedSha: sha, critique: { decision: "approve", by: "critic" } } } as never, at: 2 });
    await phases.drive(phases.list({ live: true })[0]!);
    expect(sent.find((task) => task.id === "T1")).toMatchObject({ project_cwd: "/work/bot", objective: "Project skeleton: given an empty repo, when npm test runs, then it passes" });
    expect(sent.find((task) => task.id === "T2")).toMatchObject({ project_cwd: "/elsewhere", objective: "its own" });
  });

  it("sends every piece through the full task graph, so its acceptance reads verdicts [sma:p6_l_verdict]", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.send", async () => ({}));
    harness.sdk.stub("threads.get", async () => ({ status: "active", environmentId: "env_pm" }));
    harness.sdk.stub("environments.get", async () => ({ path: "/work/bot", hostId: "h1" }));
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    const sent: Array<Record<string, unknown>> = [];
    const services = { dispatchWriter: async (input: { task: Record<string, unknown> }) => { sent.push(input.task); return { taskId: input.task.id, runId: "run1" }; }, runBudgets: { get: () => undefined } } as unknown as Services;
    const phases = createPhaseDriver(createCore(bb, db), services).phases;
    const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Bot", goal: "a bot" });
    const quick: PlanItem = { id: "T1", title: "Skeleton", wave: 1, promise: { given: "g", when: "w", then: "t" },
      task: { id: "T1", owns_paths: ["src/**"], verification: [{ command: "npm test" }], acceptance: ["npm test passes"], quality_mode: "quick" } };
    const sha = planSignature([quick], "ctx");
    savePhase(db, phase.id, { stage: "execution", runId: "run1", record: { ...phase.record, plan: { items: [quick], contextSha: "ctx", sha, admittedSha: sha, critique: { decision: "approve", by: "critic" } } } as never, at: 2 });
    await phases.drive(phases.list({ live: true })[0]!);
    expect(sent[0]).toMatchObject({ id: "T1", quality_mode: "full" });
  });
});
