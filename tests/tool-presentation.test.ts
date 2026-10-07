import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { LANE_PILOT_READ_NAME } from "../src/bounded-read";
import { TOOL_PRESENTATION, presentationFor } from "../src/server/tool-presentation";

const QUIET = ["lane_pilot_wait_writer", "lane_pilot_wait_specialist", "lane_pilot_wait_errand", "lane_pilot_relay_list", "lane_pilot_read", "lane_pilot_remind", "lane_pilot_workflow_draft_get", "lane_pilot_workflow_capabilities", "lane_pilot_workflow_status"];

describe("tool presentation", () => {
  let dispose: (() => Promise<void> | void) | null = null;
  afterEach(async () => { await dispose?.(); dispose = null; });

  it("labels every registered lane_pilot tool in both languages and collapses the noisy ones", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const tools = harness.registrations.agentTools.filter((tool) => tool.name.startsWith("lane_pilot_"));
    expect(tools.map((tool) => tool.name)).toContain(LANE_PILOT_READ_NAME);
    expect(tools.filter((tool) => !tool.presentation).map((tool) => tool.name)).toEqual([]);
    expect(tools.filter((tool) => tool.presentation?.suppress).map((tool) => tool.name).sort()).toEqual([...QUIET].sort());
    // Nothing in the table names a tool that does not exist any more.
    expect(Object.keys(TOOL_PRESENTATION).filter((name) => !tools.some((tool) => tool.name === name))).toEqual([]);
    // Nothing stored: both languages stand in one label (BB has no locale hook for a label).
    expect(tools.find((tool) => tool.name === "lane_pilot_dispatch_writer")!.presentation!.label)
      .toEqual({ pending: "Sending a task to a writer / Отправляю задачу писателю", completed: "Sent a task to a writer / Задача отправлена писателю" });
  });

  it("keeps every label of every language within BB's 80 characters", () => {
    for (const name of Object.keys(TOOL_PRESENTATION)) {
      for (const locale of ["en", "ru", "both"] as const) {
        const { label } = presentationFor(name, locale)!;
        expect(label.pending.length).toBeLessThanOrEqual(80);
        expect(label.completed.length).toBeLessThanOrEqual(80);
        expect(label.pending).not.toBe(label.completed);
      }
    }
    expect(presentationFor("lane_pilot_remind", "ru")).toMatchObject({ label: { pending: "Ставлю напоминание" }, suppress: true });
    expect(presentationFor("not_ours", "en")).toBeUndefined();
  });

  it("labels the workflow architect's tools in English and Russian; reads are quiet, changes and publishing are shown", () => {
    expect(presentationFor("lane_pilot_workflow_draft_patch", "en")).toEqual({ label: { pending: "Changing the workflow draft", completed: "Changed the workflow draft" } });
    expect(presentationFor("lane_pilot_workflow_draft_patch", "ru")).toEqual({ label: { pending: "Дорабатываю цепочку", completed: "Цепочка доработана" } });
    expect(presentationFor("lane_pilot_workflow_draft_test", "ru")?.label.completed).toBe("Цепочка проверена на заглушках");
    expect(presentationFor("lane_pilot_workflow_draft_publish", "en")?.label.pending).toBe("Publishing the workflow");
    expect(presentationFor("lane_pilot_workflow_capabilities", "en")?.suppress).toBe(true);
    expect(presentationFor("lane_pilot_workflow_draft_get", "ru")?.suppress).toBe(true);
    for (const name of ["create", "patch", "test", "publish"]) expect(presentationFor(`lane_pilot_workflow_draft_${name}`, "both")?.suppress).toBeUndefined();
  });
});
