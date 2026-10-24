import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCore } from "../src/rooms/core/server/core";
import type { Services } from "../src/rooms/core/server/services";
import { createPhaseDriver } from "../src/rooms/phase/server/driver";
import { planSignature, type PlanItem } from "../src/rooms/phase/logic";
import { savePhase } from "../src/rooms/phase/store";
import { createRun, createTask, openDatabase } from "../src/rooms/storage";

const piece = (acceptance: string[]): PlanItem => ({ id: "notes", title: "Notes", wave: 1, promise: { given: "g", when: "w", then: "t" },
  task: { id: "notes", owns_paths: ["src/**"], verification: [{ command: "node --test" }], acceptance } });

async function phaseIssuedBeforePrints(sentAcceptance: string[], planAcceptance: string[]) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.send", async () => ({}));
  harness.sdk.stub("threads.get", async () => ({ status: "active" }));
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  createTask(db, { id: "notes", runId: "run1", kind: "bb", contract: piece(sentAcceptance).task });
  const dispatched: string[] = [];
  const services = { dispatchWriter: async (input: { task: { id: string } }) => { dispatched.push(input.task.id); return { taskId: input.task.id, runId: "run1" }; }, runBudgets: { get: () => undefined } } as unknown as Services;
  const phases = createPhaseDriver(createCore(bb, db), services).phases;
  const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Notes", goal: "notes" });
  const items = [piece(planAcceptance)];
  const sha = planSignature(items, "ctx");
  savePhase(db, phase.id, { stage: "execution", runId: "run1", record: { ...phase.record, plan: { items, contextSha: "ctx", sha, admittedSha: sha, critique: { decision: "approve", by: "critic" } },
    execution: { issued: { notes: "notes" }, startedAt: 1 } } as never, at: 2 });
  await phases.drive(phases.list({ live: true })[0]!);
  return dispatched;
}

describe("a piece issued before the contract prints existed", () => {
  it("is issued again as a redo when the PM changed its acceptance since", async () => {
    expect(await phaseIssuedBeforePrints(["npm test is green"], ["the three notes test files are in the npm test script"])).toEqual(["notes.2"]);
  });
  it("keeps its work when the contract it went out with is the plan's", async () => {
    expect(await phaseIssuedBeforePrints(["works"], ["works"])).toEqual([]);
  });
});
