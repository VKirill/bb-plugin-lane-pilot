/** @vitest-environment jsdom */
// Region 8 · Daemon front outside the graphs, batch a (window half) — n684. The window is what the plugin's app entry registers.
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { describe, expect, it } from "vitest";

describe("the window ships with the plugin (n684)", () => {
  it("[sma:m_gt_static] the plugin's app entry registers the window's pages at their paths: the main page, the council and the cockpit, each under its own id", async () => {
    const app = await loadPluginApp(() => import("../../app"));
    const panels = app.navPanels.map((panel) => `${panel.id}=${(panel as { path?: string }).path}`);
    expect(panels).toEqual(["lane-pilot=lane-pilot", "lane-pilot-council=lane-pilot-council", "lane-pilot-cockpit=lane-pilot-cockpit"]);
  });
});
