// The phase pass's poke (src/rooms/phase/server/driver.ts): a stage the machine owns and can run is not poked to the PM,
// even when its start failed this pass (the retry is booked); a phase the machine cannot run — no run behind it — is
// poked at once (tests/sma/four-proofs-r04-a.test.ts [sma:dt_timer] holds that side through the timer).
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { createCore } from "../src/rooms/core/server/core";
import { createRun, openDatabase, setRunThread } from "../src/rooms/plugin-db";
import { getPhase, listParts } from "../src/rooms/phase/store";
import type { Services } from "../server";
import { createPhaseDriver } from "./phase-driver";

it("a phase with a run whose analysis fails to start books the retry and does not poke the PM in that pass", async () => {
  const sent: string[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.send", async (input: { input: Array<{ text: string }> }) => { sent.push(input.input[0]!.text); return {}; });
  harness.sdk.stub("threads.get", async () => ({ status: "idle" }));
  harness.sdk.stub("threads.list", async () => []);
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  setRunThread(db, "run1", "thr_pm");
  // resolveWorkflow comes from the helper (the built-in lp.analyze); start is the injected failure the test must reach.
  let starts = 0;
  const workflowEngine = { snapshot: () => null, get: () => null, start: () => { starts += 1; throw new Error("analysis start refused"); } };
  const { phases } = createPhaseDriver(createCore(bb, db), { runBudgets: { get: () => undefined }, workflowEngine } as unknown as Services);
  const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Run", goal: "a phase the machine drives" });
  expect(phase.runId).toBe("run1");
  await phases.tick();
  // The injected start failure was reached, once, and booked as the stage's one try (a product failure: the reason is no machine fault).
  expect(starts).toBe(1);
  const record = getPhase(db, phase.id)!.record;
  expect(record.autoFailures?.analyze).toBe(1);
  expect(record.autoMachineFailures?.analyze).toBeUndefined();
  expect(listParts(db, phase.id).filter((part) => part.kind === "auto_failed").map((part) => part.text)).toEqual([expect.stringContaining("(analysis start refused): run again on the next pass")]);
  expect(sent.filter((text) => text.includes(`Phase ${phase.id}`))).toEqual([]);
  await harness.lifecycle.dispose();
});
