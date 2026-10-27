import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { bindGraphStepLookup, fullAccessSpawn, quietHelper } from "../../src/rooms/core/server/pm-spawn";

describe("quietHelper", () => {
  it("marks helpers Lane Pilot watches, not the PM, errands, specialists or root threads", () => {
    const child = (role: string) => ({ parentThreadId: "thr_pm", pluginMetadata: { role, lanePilotRunId: "run" } });
    for (const role of ["writer", "plan-critic", "pm-reader", "memory-maintainer", "docs-maintainer", "browser-qa"]) {
      expect(quietHelper(child(role)).pluginMetadata).toMatchObject({ role, experimental_vkQuietChild: true });
    }
    for (const role of ["pm", "errand", "specialist", "self-repair"]) {
      expect(quietHelper(child(role)).pluginMetadata).not.toHaveProperty("experimental_vkQuietChild");
    }
    // A step of a graph run never wakes the PM chat, whatever its role: the run-end notice still comes.
    for (const role of ["errand", "specialist", "self-repair"]) {
      expect(quietHelper({ parentThreadId: "thr_pm", pluginMetadata: { role, lanePilotWorkflowRunId: "wfr_1" } }).pluginMetadata).toMatchObject({ role, experimental_vkQuietChild: true });
    }
    expect(quietHelper({ parentThreadId: "thr_pm", pluginMetadata: { role: "errand", lanePilotWorkflowRunId: "" } }).pluginMetadata).not.toHaveProperty("experimental_vkQuietChild");
    expect(quietHelper({ pluginMetadata: { role: "writer" } }).pluginMetadata).not.toHaveProperty("experimental_vkQuietChild");
    expect(quietHelper({ parentThreadId: "thr_pm" })).toEqual({ parentThreadId: "thr_pm" });
  });

  it("takes a graph marker for a graph only when the run (and the step it names) is real: a made-up id leaves a loud role loud", () => {
    const real = (runId: string, stepKey?: string) => runId === "wfrun_1" && (stepKey === undefined || stepKey === "step_1");
    const meta = (role: string, extra: Record<string, unknown>) => ({ parentThreadId: "thr_pm", pluginMetadata: { role, ...extra } });
    expect(quietHelper(meta("errand", { lanePilotWorkflowRunId: "wfrun_1", lanePilotWorkflowStep: "step_1" }), real).pluginMetadata).toHaveProperty("experimental_vkQuietChild", true);
    expect(quietHelper(meta("errand", { lanePilotWorkflowRunId: "route-lprun_dead" }), real).pluginMetadata).not.toHaveProperty("experimental_vkQuietChild");
    expect(quietHelper(meta("errand", { lanePilotWorkflowRunId: "wfrun_1", lanePilotWorkflowStep: "gone" }), real).pluginMetadata).not.toHaveProperty("experimental_vkQuietChild");
    // A quiet role stays quiet whatever the marker says: the marker only lifts the loud roles.
    expect(quietHelper(meta("writer", { lanePilotWorkflowRunId: "route-lprun_dead" }), real).pluginMetadata).toHaveProperty("experimental_vkQuietChild", true);
  });

  it("the spawn reads the bound lookup: a loud role with a false marker is spawned loud, with a real one quiet", async () => {
    const spawned: Array<{ pluginMetadata?: Record<string, unknown> }> = [];
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: { spawn: async (args: never) => { spawned.push(args); return { id: `t${spawned.length}` }; } } } as never });
    bindGraphStepLookup(bb, (runId, stepKey) => runId === "wfrun_1" && stepKey === "step_1");
    const ask = (extra: Record<string, unknown>) => fullAccessSpawn(bb, { projectId: "P", parentThreadId: "thr_pm", prompt: "x", pluginMetadata: { role: "errand", ...extra } } as never);
    await ask({ lanePilotWorkflowRunId: "wfrun_1", lanePilotWorkflowStep: "step_1" });
    await ask({ lanePilotWorkflowRunId: "route-lprun_dead", lanePilotWorkflowStep: "route-ab" });
    expect(spawned[0]!.pluginMetadata).toHaveProperty("experimental_vkQuietChild", true);
    expect(spawned[1]!.pluginMetadata).not.toHaveProperty("experimental_vkQuietChild");
  });
});
