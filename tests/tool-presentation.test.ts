import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { LANE_PILOT_READ_NAME } from "@lane-pilot/kit";
import { TOOL_PRESENTATION, presentationFor, toolLocale } from "../src/rooms/tools/server/tool-presentation";
import { knownOwnerLocale } from "../src/rooms/relay/server";

const QUIET = ["lane_pilot_tool_search", "lane_pilot_wait_writer", "lane_pilot_wait_specialist", "lane_pilot_wait_errand", "lane_pilot_relay_list", "lane_pilot_read", "lane_pilot_workflow_draft_get", "lane_pilot_workflow_capabilities", "lane_pilot_workflow_status"];

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
    expect(presentationFor("lane_pilot_relay", "ru")).toMatchObject({ label: { pending: "Пишу в другой чат" } });
    expect(presentationFor("not_ours", "en")).toBeUndefined();
  });

  it("labels the workflow architect's tools in English and Russian; reads are quiet, changes and publishing are shown", () => {
    expect(presentationFor("lane_pilot_workflow_draft_patch", "en")).toEqual({ label: { pending: "Changing the workflow draft", completed: "Changed the workflow draft" } });
    expect(presentationFor("lane_pilot_workflow_draft_patch", "ru")).toEqual({ label: { pending: "Дорабатываю граф", completed: "Граф доработан" } });
    expect(presentationFor("lane_pilot_workflow_draft_test", "ru")?.label.completed).toBe("Граф проверен на заглушках");
    expect(presentationFor("lane_pilot_workflow_draft_publish", "en")?.label.pending).toBe("Publishing the workflow");
    expect(presentationFor("lane_pilot_workflow_capabilities", "en")?.suppress).toBe(true);
    expect(presentationFor("lane_pilot_workflow_draft_get", "ru")?.suppress).toBe(true);
    for (const name of ["create", "patch", "test", "publish"]) expect(presentationFor(`lane_pilot_workflow_draft_${name}`, "both")?.suppress).toBeUndefined();
  });

  // Live 2026-10-27: on «Auto» a row read «Called a helper / Помощник отработал». The app records the language it resolved (preferences:resolved-locale).
  describe("the language of the row labels", () => {
    const withKv = (values: Record<string, unknown>) => ({ storage: { kv: { get: async (key: string) => values[key] ?? null } } });
    const locale = async (values: Record<string, unknown>) => toolLocale(await knownOwnerLocale(withKv(values)));
    it("follows the owner's explicit choice", async () => {
      expect(await locale({ "preferences:locale": "en", "preferences:resolved-locale": "ru" })).toBe("en");
      expect(await locale({ "preferences:locale": "ru" })).toBe("ru");
    });
    it("on Auto takes the locale the app resolved, in one language", async () => {
      expect(await locale({ "preferences:locale": "auto", "preferences:resolved-locale": "en" })).toBe("en");
      expect(await locale({ "preferences:resolved-locale": "ru" })).toBe("ru");
    });
    it("shows both languages only when nothing is known", async () => {
      expect(await locale({})).toBe("both");
      expect(await locale({ "preferences:locale": "auto", "preferences:resolved-locale": "de" })).toBe("both");
    });
    it("labels a started plugin in the resolved language", async () => {
      const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
      await bb.storage.kv.set("preferences:resolved-locale", "en");
      await plugin(bb);
      dispose = () => harness.lifecycle.dispose();
      const phase = harness.registrations.agentTools.find((tool) => tool.name === "lane_pilot_phase") as unknown as { presentation: { label: { completed: string } } };
      expect(phase.presentation.label.completed).toBe("Moved the phase");
    });
  });
});
