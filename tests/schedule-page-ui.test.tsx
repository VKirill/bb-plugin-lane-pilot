/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { openTab } from "./ui-tabs";
import { cleanup, fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { VISIBLE_CATALOG } from "../src/ui-catalog";

afterEach(() => cleanup());

function screenFixture() {
  const values = Object.fromEntries(VISIBLE_CATALOG.map((row) => [row.storageKey, row.defaultValue]));
  values["writer.provider"] = "codex";
  values["writer.model"] = "test-model";
  values["writer.reasoning_effort"] = "medium";
  return {
    projectId: "proj_ui", hostId: "host_ui", workspacePath: "/tmp/lane-pilot-ui",
    explicitKeys: ["writer.provider", "writer.model", "writer.reasoning_effort"], values,
    versions: Object.fromEntries(VISIBLE_CATALOG.map((row) => [row.storageKey, 1])),
    importSource: { completed: true, at: 1, routingPath: "/tmp/routing.profile.yaml", nightPath: "/tmp/night-shift.yaml" },
    runs: [], unapplied: [], cliPreview: { argv: ["run"], env: {}, applied: [], unapplied: [] }, legacyStack: true,
    lastSnapshotPath: "/tmp/snapshot", lastReceiptJson: null, writerResultJson: null, writerResultPatch: null, cliReceiptJson: null, qaHosts: [], lastWriterTrace: null,
  };
}

async function mountPage(rpc: Record<string, (input: unknown) => unknown> = {}) {
  const app = await loadPluginApp(() => import("../app"));
  return renderSlot(app.navPanels[0]!, { subPath: "" }, {
    context: { projectId: "proj_ui", threadId: null },
    providers: { status: "ready", providers: [] as never },
    rpc: {
      get_preferences: (input: unknown) => ({ locale: (input as { suggestedLocale: "en" | "ru" }).suggestedLocale, preference: "auto", lastProjectId: null }),
      set_locale: (input: unknown) => ({ locale: (input as { locale: string }).locale === "auto" ? "en" : (input as { locale: string }).locale, preference: (input as { locale: string }).locale }),
      remember_project: () => ({ ok: true }),
      list_projects: () => ({ projects: [{ id: "proj_ui", name: "UI test" }], lastProjectId: "proj_ui" }),
      finish_run: () => ({ projectId: "proj_ui", finishedRunIds: [], closed: true }),
      get_screen: () => screenFixture(),
      get_globals: () => ({ defaults: {}, revision: 0, agents: [] }),
      save_setting: () => ({ ok: true, conflict: false, version: 2, value: true }),
      save_settings: () => ({ ok: true, conflict: false, values: {}, versions: {} }),
      ...rpc,
    },
  });
}

const empty = () => ({ schedules: [], hosts: [], now: Date.now() });

describe("automation area in the page", { timeout: 20_000 }, () => {
  it("is a project tab beside Workflows and shows that project's board", async () => {
    const slot = await mountPage({ schedule_list: empty });
    await slot.findByTestId("tab-schedule");
    expect(slot.getByTestId("tab-schedule").textContent).toBe("Automation");
    openTab(slot, "schedule");
    await slot.findByTestId("sch-empty");
    expect(slot.rpcCalls.find((call) => call.method === "schedule_list")?.input).toEqual({ projectId: "proj_ui", next: 5 });
    slot.lifecycle.unmount();
  });

  it("is a global page for the schedules of every project", async () => {
    const slot = await mountPage({ schedule_list: empty });
    fireEvent.click(await slot.findByTestId("scope-nav-schedule"));
    await slot.findByTestId("sch-empty");
    expect(slot.rpcCalls.find((call) => call.method === "schedule_list")?.input).toEqual({ next: 5 });
    slot.lifecycle.unmount();
  });
});
