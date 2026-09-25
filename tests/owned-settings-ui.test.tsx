/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import plugin from "../server";
import { setLocaleOverride } from "../i18n";

async function mount(locale: "en" | "ru") {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  await plugin(bb);
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    context: { projectId: null, threadId: null },
    rpc: {
      get_preferences: () => ({ locale, preference: locale, lastProjectId: null }),
      list_projects: () => ({ projects: [], lastProjectId: null }),
      get_globals: (input) => harness.behavior.callRpc("get_globals", input),
      get_agent_inventory: () => ({
        skills: { status: "ready", items: [{ name: "copywriter", label: "copywriter" }] },
        mcpServers: { status: "unavailable", items: [] },
        tools: { status: "unavailable", items: [] },
        disallowedTools: { status: "unavailable", items: [] },
      }),
      save_globals: (input) => harness.behavior.callRpc("save_globals", input),
      save_agent_profile: (input) => harness.behavior.callRpc("save_agent_profile", input),
    },
  });
  return { slot, harness };
}
afterEach(() => { cleanup(); setLocaleOverride(null); });
describe("owned settings source DOM", () => {
  it.each(["en", "ru"] as const)("preserves an instruction draft across scopes, saves and reads back (%s)", async (locale) => {
    const { slot, harness } = await mount(locale);
    try {
      const ru = locale === "ru";
      fireEvent.click(await slot.findByRole("tab", { name: ru ? "Агенты" : "Agents" }));
      const prompt = await slot.findByLabelText(ru ? "Инструкции" : "Instructions");
      fireEvent.change(prompt, { target: { value: "My independent instructions" } });
      fireEvent.click(slot.getByRole("tab", { name: ru ? "Общие настройки" : "General settings" }));
      fireEvent.click(slot.getByRole("tab", { name: ru ? "Агенты" : "Agents" }));
      expect((slot.getByLabelText(ru ? "Инструкции" : "Instructions") as HTMLTextAreaElement).value).toBe("My independent instructions");
      fireEvent.click(slot.getByRole("button", { name: ru ? "Сохранить" : "Save" }));
      await slot.findByRole("status");
      const readback: any = await harness.behavior.callRpc("get_globals", {});
      expect(readback.agents[0].prompt).toBe("My independent instructions");
    } finally { slot.lifecycle.unmount(); await harness.lifecycle.dispose(); }
  });

  it("retains a stale editor draft on CAS conflict without overwriting another editor", async () => {
    const { slot, harness } = await mount("en");
    try {
      fireEvent.click(await slot.findByRole("tab", { name: "Agents" }));
      const prompt = await slot.findByLabelText("Instructions");
      const before: any = await harness.behavior.callRpc("get_globals", {});
      await harness.behavior.callRpc("save_agent_profile", { id: "dev-orchestrator", prompt: "Other editor", description: "Other", expectedSourceHash: before.agents[0].sourceHash });
      fireEvent.change(prompt, { target: { value: "My unsaved draft" } });
      fireEvent.click(slot.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(slot.getByRole("alert").textContent).toContain("draft is retained"));
      expect((prompt as HTMLTextAreaElement).value).toBe("My unsaved draft");
      const readback: any = await harness.behavior.callRpc("get_globals", {});
      expect(readback.agents[0].prompt).toBe("Other editor");
    } finally { slot.lifecycle.unmount(); await harness.lifecycle.dispose(); }
  });

  it("edits profile resources with inventory checkboxes instead of comma fields", async () => {
    const { slot, harness } = await mount("en");
    try {
      fireEvent.click(await slot.findByRole("tab", { name: "Agents" }));
      await slot.findByTestId("agent-resource-tools");
      expect(slot.getByTestId("agent-resource-tools").querySelector("input[type='text']")).toBeNull();
      expect(slot.getAllByText(/tool list is unavailable for the selected provider/).length).toBeGreaterThan(0);
      expect(slot.getByRole("combobox", { name: "Profile skills" })).toBeTruthy();
      expect(slot.getByRole("combobox", { name: "Allowed tools" })).toBeTruthy();
      expect(slot.queryByText(/имена через запятую/i)).toBeNull();
      fireEvent.click(slot.getByRole("combobox", { name: "Profile skills" }));
      fireEvent.click(slot.getByRole("option", { name: "Selected" }));
      expect(slot.getAllByLabelText("Search").length).toBeGreaterThan(0);
      expect(slot.getByRole("checkbox", { name: /copywriter/ })).toBeTruthy();
      fireEvent.click(slot.getByRole("combobox", { name: "Allowed tools" }));
      expect(slot.getByRole("option", { name: "Selected" })).toBeTruthy();
      expect(slot.getByRole("option", { name: "No tools" })).toBeTruthy();
      fireEvent.keyDown(slot.getByRole("listbox"), { key: "Escape" });
      fireEvent.click(slot.getByTestId("agent-resource-disallowedTools").querySelector("[role='combobox']") as HTMLElement);
      expect(slot.getByRole("option", { name: "Disallow nothing" })).toBeTruthy();
    } finally { slot.lifecycle.unmount(); await harness.lifecycle.dispose(); }
  });
});
