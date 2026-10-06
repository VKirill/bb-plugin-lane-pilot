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

    const slot = renderSlot(panelAction, { threadId: "thr_pm", params: {} }, {
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
});
