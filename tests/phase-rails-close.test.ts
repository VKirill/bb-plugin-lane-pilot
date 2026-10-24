import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCore } from "../src/rooms/core/server/core";
import type { Services } from "../src/rooms/core/server/services";
import { createPhaseDriver } from "../src/rooms/phase/server/driver";
import { phaseToolParams } from "../src/rooms/phase/server/tool";
import { createRun, openDatabase } from "../src/rooms/storage";

function driver(status = "idle") {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const sent: string[] = [];
  harness.sdk.stub("threads.send", async (input: { input: Array<{ text: string }> }) => { sent.push(input.input[0]!.text); return {}; });
  harness.sdk.stub("threads.get", async () => ({ status }));
  harness.sdk.stub("threads.list", async () => []);
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  return Object.assign(createPhaseDriver(createCore(bb, db), {} as Services).phases, { sent });
}

describe("a phase the rails opened", () => {
  it("is not closed by the PM before acceptance, and is by the owner", async () => {
    const phases = driver();
    const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Stats", goal: "stats module", rails: true });
    expect(phase.record.rails).toBe(true);
    expect(() => phases.setState({ phaseId: phase.id, state: "close", words: "small job", by: "pm" })).toThrow(/opened by the rails/);
    expect(phases.setState({ phaseId: phase.id, state: "close", words: "not needed", by: "owner" }).state).toBe("closed");
  });
  it("a phase the PM opened itself is closed by the PM as before", async () => {
    const phases = driver();
    const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Stats", goal: "stats module" });
    expect(phases.setState({ phaseId: phase.id, state: "close", words: "dropped", by: "pm" }).state).toBe("closed");
  });
});

describe("the driver's poke", () => {
  it("goes to an idle PM once, and waits while the PM is busy", async () => {
    const busy = driver("active");
    await busy.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Stats", goal: "stats module", rails: true });
    await busy.tick();
    expect(busy.sent.filter((text) => text.startsWith("[Lane Pilot phase]"))).toEqual([]);
    const idle = driver("idle");
    await idle.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Stats", goal: "stats module", rails: true });
    await idle.tick();
    await idle.tick();
    expect(idle.sent.filter((text) => text.startsWith("[Lane Pilot phase]"))).toHaveLength(1);
  });
});

describe("the phase tool takes JSON text for its lists and objects", () => {
  it("parses a context report sent as text, as a live PM sent it", () => {
    const parsed = phaseToolParams.parse({ action: "context", phaseId: "ph_1", docs: "[\".agents/phases/ph_1/CONTEXT.md\"]",
      risks: "{\"technical\":\"t\",\"product\":\"p\",\"operations\":\"o\",\"security\":\"s\"}", decisions: "[\"D1\"]" });
    expect(parsed).toMatchObject({ docs: [".agents/phases/ph_1/CONTEXT.md"], risks: { technical: "t" }, decisions: ["D1"] });
  });
  it("still refuses text that is not JSON of the field's type, and takes a rubric by phaseId", () => {
    expect(phaseToolParams.safeParse({ action: "context", phaseId: "ph_1", docs: "CONTEXT.md", risks: {} }).success).toBe(false);
    expect(phaseToolParams.safeParse({ action: "rubric", phaseId: "ph_1" }).success).toBe(true);
  });
});
