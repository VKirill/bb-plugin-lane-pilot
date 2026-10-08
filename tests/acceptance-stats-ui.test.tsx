/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { openTab } from "./ui-tabs";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { VISIBLE_CATALOG } from "@lane-pilot/settings-catalog";

afterEach(() => cleanup());

function screenFixture() {
  const values = Object.fromEntries(VISIBLE_CATALOG.map((row) => [row.storageKey, row.defaultValue]));
  values["writer.provider"] = "codex";
  values["writer.model"] = "test-model";
  values["writer.reasoning_effort"] = "medium";
  return {
    projectId: "proj_ui",
    hostId: "host_ui",
    workspacePath: "/tmp/lane-pilot-ui",
    explicitKeys: ["writer.provider", "writer.model", "writer.reasoning_effort"],
    values,
    versions: Object.fromEntries(VISIBLE_CATALOG.map((row) => [row.storageKey, 1])),
    importSource: { completed: true, at: 1, routingPath: "/tmp/routing.profile.yaml", nightPath: "/tmp/night-shift.yaml" },
    runs: [],
    unapplied: [],
    cliPreview: { argv: ["run"], env: {}, applied: [], unapplied: [] },
    legacyStack: true,
    lastSnapshotPath: "/tmp/snapshot",
    lastReceiptJson: null,
    writerResultJson: null,
    writerResultPatch: null,
    cliReceiptJson: null,
    qaHosts: [],
    lastWriterTrace: null,
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

describe("acceptance stats card", { timeout: 20_000 }, () => {
  it("shows first-try %, eventual %, redispatch % and top causes on Runs → Analytics", async () => {
    const week = "2026-W40";
    const slot = await mountPage({
      acceptance_stats: () => ({
        days: 28,
        totals: { dispatched: 4, firstTryAccepted: 2, eventuallyAccepted: 3, attempts: 7, attemptsPerAccepted: 1.8, redispatched: 1, families: 1, causes: { outputs_empty: 2, needs_human: 1 } },
        projects: [{
          projectId: "proj_ui",
          totals: { dispatched: 4, firstTryAccepted: 2, eventuallyAccepted: 3, attempts: 7, attemptsPerAccepted: 1.8, redispatched: 1, families: 1, causes: { outputs_empty: 2, needs_human: 1 } },
          weeks: [{ week, dispatched: 4, firstTryAccepted: 2, eventuallyAccepted: 3, attempts: 7, attemptsPerAccepted: 1.8, redispatched: 1, families: 1, causes: { outputs_empty: 2, needs_human: 1 } }],
        }],
      }),
    });
    openTab(slot, "runs", "analytics");
    await waitFor(() => expect(slot.getByTestId("acceptance-stats")).toBeTruthy());
    expect(slot.getByTestId("acceptance-stats").textContent).toContain("Принятие с первой попытки");
    const row = slot.getByTestId(`acceptance-stats-week-${week}`);
    expect(row.textContent).toContain("50%");   // first-try 2/4
    expect(row.textContent).toContain("75%");   // eventual 3/4
    expect(row.textContent).toContain("25%");   // redispatched 1/4
    expect(slot.getByTestId("acceptance-stats-total").textContent).toContain("пустой вывод ×2");
    expect(slot.getByTestId("acceptance-stats-total").textContent).toContain("needs_human ×1");
    slot.lifecycle.unmount();
  });
});
