/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

beforeAll(() => {
  class Matrix { m22 = 1; m41 = 0; m42 = 0; constructor(_init?: string) {} }
  vi.stubGlobal("DOMMatrixReadOnly", Matrix);
});
afterEach(() => { cleanup(); setLocaleOverride(null); localStorage.clear(); });

const stats = (over: Record<string, unknown> = {}) => ({
  runs: 0, succeeded: 0, failed: 0, active: 0, executed: 0, workDone: 0, refused: 0, escalated: 0,
  runs30d: 0, successRate: null, lastRunAt: null, lastStatus: null, lastRunId: null, ...over,
});
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: { en: `Graph ${id}`, ru: `Граф ${id}` }, description: { en: `${id} does its thing`, ru: `${id} делает своё дело` },
  status: "published", version: 1, scope: "global", internal: false, tags: [] as string[], nodes: 3, warnings: 0,
  stats: stats(), ...over,
});

/** A stubbed rpc: the library screen's shape without a server, so the grouping logic is what is under test. */
const world = (workflows: unknown[]) => ({
  rpc: {
    get_preferences: () => ({ locale: "en", preference: "en", lastProjectId: null }),
    workflow_list: async () => ({ workflows, problems: [], project: "ok" }),
    workflow_draft_list: async () => ({ drafts: [] }),
  },
});

async function mount(rpc: Record<string, unknown>, props: Record<string, unknown> = {}) {
  await loadPluginApp(() => import("../app"));
  const { WorkflowsScreen } = await import("../src/rooms/workflow/ui/workflows");
  return renderSlot({ component: () => <WorkflowsScreen locale="en" projectId={null} {...props} /> }, {}, { context: { projectId: null, threadId: null }, rpc: rpc as never });
}

describe("Workflow library by categories", () => {
  it("groups rows in WORKFLOW_CATEGORIES order, chips carry counts, and service starts collapsed", async () => {
    const { rpc } = world([
      row("seo-page", { tags: ["seo"] }),
      row("plain-task"),
      row("x-post", { tags: ["social"], status: "draft" }),
      row("lp.janitor"),
    ]);
    const slot = await mount(rpc);
    await slot.findByTestId("wf-row-seo-page");
    const order = Array.from(slot.getByTestId("wf-list").querySelectorAll("[data-testid^='wf-category-']")).map((node) => node.getAttribute("data-testid"));
    expect(order).toEqual(["wf-category-seo", "wf-category-code", "wf-category-content", "wf-category-service"]);
    expect(slot.getByTestId("wf-chip-seo").textContent).toContain("1 graph");
    expect(slot.getByTestId("wf-chip-all")).toBeTruthy();
    // The service shelf is collapsed: its row exists in no group body yet.
    expect(slot.getByTestId("wf-category-service").querySelector("[data-testid='wf-row-lp.janitor']")).toBeNull();
    fireEvent.click(slot.getByTestId("wf-cat-toggle-service"));
    expect(slot.getByTestId("wf-category-service").querySelector("[data-testid='wf-row-lp.janitor']")).toBeTruthy();
  });

  it("shows the top-3 by runs30d in «Most used» and mutes graphs that never ran", async () => {
    const { rpc } = world([
      row("a1", { stats: stats({ runs: 10, runs30d: 9, successRate: 0.8, lastRunAt: 1_700_000_000_000 }) }),
      row("a2", { stats: stats({ runs: 5, runs30d: 5, successRate: 1 }) }),
      row("a3", { stats: stats({ runs: 4, runs30d: 4 }) }),
      row("a4", { stats: stats({ runs: 3, runs30d: 3 }) }),
      row("cold"),
    ]);
    const slot = await mount(rpc);
    await slot.findByTestId("wf-row-a1");
    const topRows = Array.from(slot.getByTestId("wf-top-code").querySelectorAll("[data-testid^='wf-top-a']")).map((n) => n.getAttribute("data-testid"));
    expect(topRows).toEqual(["wf-top-a1", "wf-top-a2", "wf-top-a3"]);
    expect(slot.getByTestId("wf-top-code").querySelector("[data-testid='wf-top-a4']")).toBeNull();
    // a4 and the never-run graph are in the rest of the shelf; the cold one is muted but clickable.
    expect(slot.getByTestId("wf-row-a4")).toBeTruthy();
    expect(slot.getByTestId("wf-row-cold").className).toContain("opacity-60");
    expect(slot.getByTestId("wf-top-a1").textContent).toContain("80% work done");
  });

  it("a category chip focuses its shelf and expands it; «All» clears the focus", async () => {
    const { rpc } = world([row("seo-page", { tags: ["seo"] }), row("lp.janitor")]);
    const slot = await mount(rpc);
    await slot.findByTestId("wf-row-seo-page");
    fireEvent.click(slot.getByTestId("wf-chip-service"));
    await waitFor(() => expect(slot.getByTestId("wf-category-service").querySelector("[data-testid='wf-row-lp.janitor']")).toBeTruthy());
    expect(slot.getByTestId("wf-category-service").getAttribute("data-focused")).toBe("1");
    fireEvent.click(slot.getByTestId("wf-chip-all"));
    await waitFor(() => expect(slot.getByTestId("wf-category-service").getAttribute("data-focused")).toBeNull());
  });

  it("search keeps working across groups and hides emptied shelves", async () => {
    const { rpc } = world([row("seo-page", { tags: ["seo"] }), row("plain-task")]);
    const slot = await mount(rpc);
    await slot.findByTestId("wf-row-seo-page");
    fireEvent.change(slot.getByTestId("wf-search"), { target: { value: "seo" } });
    await waitFor(() => expect(slot.queryByTestId("wf-category-code")).toBeNull());
    expect(slot.getByTestId("wf-category-seo")).toBeTruthy();
    expect(slot.getByTestId("wf-count").textContent).toBe("1/2");
  });

  it("remembers the list/grid choice and renders the map view behind the switch", async () => {
    const { rpc } = world([row("plain-task")]);
    const slot = await mount(rpc, {
      headerActions: <button data-testid="wf-stub-action">act</button>,
      mapView: <div data-testid="wf-stub-map">the map</div>,
    });
    await slot.findByTestId("wf-row-plain-task");
    expect(slot.getByTestId("wf-stub-action")).toBeTruthy();
    fireEvent.click(slot.getByTestId("wf-layout-list"));
    expect(localStorage.getItem("lp.wf.view")).toBe("list");
    fireEvent.click(slot.getByTestId("wf-tab-map"));
    expect(slot.getByTestId("wf-stub-map")).toBeTruthy();
    expect(slot.queryByTestId("wf-list")).toBeNull();
    fireEvent.click(slot.getByTestId("wf-tab-library"));
    expect(slot.getByTestId("wf-list")).toBeTruthy();
  });
});
