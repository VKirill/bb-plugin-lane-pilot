/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

afterEach(() => {
  cleanup();
});

async function mountBadge(input: {
  helpers?: Array<{ id: string; title: string; status: string; role: string; detail: string | null; phase?: string | null }>;
  queued?: string[];
}) {
  const app = await loadPluginApp(() => import("../app"));
  const banner = app.composerCustomizations.find((row) => row.id === "lane-pilot-agent-badge")?.banners?.[0];
  if (!banner) throw new Error("missing agent badge banner");
  return renderSlot({ component: banner.component }, {}, {
    context: {
      projectId: "proj_1",
      threadId: "thr_pm",
    },
    composer: { scope: { kind: "thread", threadId: "thr_pm" }, text: "" },
    rpc: {
      get_preferences: () => ({
        locale: "en",
        preference: "en",
        lastProjectId: null,
      }),
      native_thread: () => ({
        token: "tok",
        agentId: "dev-orchestrator",
        agentType: "dev-orchestrator",
        projectId: "proj_1",
        description: "Development coordinator",
      }),
      list_helper_threads: () => ({ threads: input.helpers ?? [], queued: input.queued ?? [] }),
    },
  });
}

describe("Helper chips & panel phase rendering", () => {
  it("renders active thinking writer with pulse dot", async () => {
    const slot = await mountBadge({
      helpers: [
        { id: "thr_1", title: "Task 1", status: "active", role: "writer", detail: null, phase: "работает" },
      ],
    });
    const chip = await slot.findByTestId("helper-chip-thr_1");
    expect(chip).toBeTruthy();
    expect(slot.getByTestId("active-dot")).toBeTruthy();
    expect(slot.queryByTestId("verifying-dot")).toBeNull();
    expect(chip.getAttribute("title")).toBe("Writer: Task 1 (работает)");
    slot.lifecycle.unmount();
  });

  // 2026-10-12: the chips live in BB's prompt box, where only BB's Tailwind applies; BB 0.46 has no `-top-0.5`, so the dot sat
  // in the middle of the right edge. Its corner must not depend on a host class.
  it("pins the status dot to the chip's top-right corner with inline offsets", async () => {
    const slot = await mountBadge({
      helpers: [
        { id: "thr_1", title: "Task 1", status: "active", role: "specialist", detail: null, phase: "работает" },
        { id: "thr_2", title: "Task 2", status: "active", role: "writer", detail: null, phase: "проверка" },
      ],
    });
    await slot.findByTestId("helper-chip-thr_2");
    for (const dot of [slot.getByTestId("active-dot"), slot.getByTestId("verifying-dot")]) {
      expect(dot.style.top).toBe("-0.125rem");
      expect(dot.style.right).toBe("-0.125rem");
      expect(dot.className).not.toMatch(/-top-|-right-/);
    }
    slot.lifecycle.unmount();
  });

  it("renders verifying writer with distinct dot (no pulse, emerald)", async () => {
    const slot = await mountBadge({
      helpers: [
        { id: "thr_2", title: "Task 2", status: "idle", role: "writer", detail: null, phase: "проверка" },
      ],
    });
    const chip = await slot.findByTestId("helper-chip-thr_2");
    expect(chip).toBeTruthy();
    expect(slot.getByTestId("verifying-dot")).toBeTruthy();
    expect(slot.queryByTestId("active-dot")).toBeNull();
    expect(chip.getAttribute("title")).toBe("Writer: Task 2 (проверка)");
    slot.lifecycle.unmount();
  });

  it("renders queued chip with «в очереди N»", async () => {
    const slot = await mountBadge({
      helpers: [],
      queued: ["task-1", "task-2"],
    });
    const queueChip = await slot.findByTestId("helper-chip-queue");
    expect(queueChip).toBeTruthy();
    expect(queueChip.textContent).toContain("в очереди 2");
    expect(queueChip.getAttribute("title")).toBe("Задачи в очереди: task-1, task-2");
    slot.lifecycle.unmount();
  });

  it("renders phase in panel list", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const panelAction = app.threadPanelActions.find((a) => a.id === "lane-helper-thread");
    if (!panelAction) throw new Error("missing panel action");

    const slot = renderSlot(panelAction, { threadId: "thr_pm", params: {}, environment: null }, {
      context: { projectId: "proj_1", threadId: "thr_pm" },
      rpc: {
        list_helper_threads: () => ({
          threads: [
            { id: "thr_1", title: "Task 1", status: "idle", role: "writer", detail: null, phase: "приёмка" },
          ],
          queued: ["task-queued-1"],
        }),
      },
    });

    await waitFor(() => expect(slot.getByTestId("helper-panel-list")).toBeTruthy());
    expect(slot.getByText("Writer: Task 1 (приёмка)")).toBeTruthy();
    expect(slot.getByTestId("helper-panel-queue").textContent).toContain("task-queued-1");
    slot.lifecycle.unmount();
  });

  it("draws the run's tasks as steps with arrows instead of the flat queue", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const panelAction = app.threadPanelActions.find((a) => a.id === "lane-helper-thread");
    if (!panelAction) throw new Error("missing panel action");
    const slot = renderSlot(panelAction, { threadId: "thr_pm", params: {}, environment: null }, {
      context: { projectId: "proj_1", threadId: "thr_pm" },
      rpc: {
        list_helper_threads: () => ({
          threads: [],
          queued: ["b", "c"],
          graph: {
            nodes: [
              { id: "a", title: "Foundation", state: "running", threadId: "thr_a" },
              { id: "b", title: "Blocks", state: "waiting", threadId: null },
              { id: "c", title: "Forms", state: "waiting", threadId: null },
            ],
            edges: [{ from: "a", to: "b", kind: "depends" }, { from: "a", to: "c", kind: "files" }],
          },
        }),
      },
    });
    await waitFor(() => expect(slot.getByTestId("task-graph")).toBeTruthy());
    expect(slot.getByTestId("task-step-0").textContent).toContain("a");
    expect(slot.getByTestId("task-step-1").textContent).toMatch(/параллельно[\s\S]*b[\s\S]*c/);
    expect(slot.queryByTestId("helper-panel-queue")).toBeNull();
    expect(slot.getByTestId("task-graph-legend").textContent).toContain("те же файлы");
    slot.lifecycle.unmount();
  });
});
