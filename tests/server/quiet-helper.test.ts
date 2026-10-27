import { describe, expect, it } from "vitest";
import { quietHelper } from "../../src/rooms/core/server/pm-spawn";

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
});
