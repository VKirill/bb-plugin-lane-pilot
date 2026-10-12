/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 20_000 });
beforeAll(() => { setLocaleOverride("en"); });
afterEach(() => { cleanup(); setLocaleOverride("en"); });

const item = (taskId: string, column: string, extra: Record<string, unknown> = {}) => ({
  kind: "task", key: `task:run:${taskId}`, runId: "run", taskId, title: `Title ${taskId}`, projectId: "proj_a", pmThreadId: "thr_pm", column,
  state: column === "blocked" ? "blocked" : "running", detail: null, attemptNo: 1, threadId: null, attemptId: `a-${taskId}`, updatedAt: 1_791_800_000_000, ...extra,
});

async function mount() {
  const app = await loadPluginApp(() => import("../app"));
  void app;
  const { TaskBoard } = await import("../src/rooms/runs/ui/task-board");
  return renderSlot({ component: () => <TaskBoard projects={[{ id: "proj_a", name: "Alpha" }]} locale="en" /> }, {}, {
    context: { projectId: null, threadId: null },
    rpc: {
      task_board: () => ({ items: [item("q1", "queued"), item("b1", "blocked", { detail: "needs_human: may I?" }),
        { ...item("", "running"), kind: "workflow", key: "workflow:wf1", runId: "wf1", taskId: null, title: "Insights post", detail: "insights-post", attemptId: null }] }),
      task_card: () => ({
        kind: "task", title: "Title b1", id: "b1", projectId: "proj_a", state: "blocked", reason: "needs_human: may I?",
        contract: { objective: "Fix the form", acceptance: ["form saves"], ownsPaths: ["a.ts"], expectedOutputs: [], dependsOn: [], checks: ["npm test"] }, plan: "1. edit",
        stages: [{ id: "plan-critique", state: "passed", reason: null, threadId: "thr_c", model: "opus", updatedAt: 1 }],
        attempts: [{ id: "a-b1", no: 1, state: "blocked", reason: "needs_human: may I?", threadId: "thr_w", createdAt: 1, updatedAt: 2 }],
        threads: { id: "thr_pm", role: "PM", title: "Coordinator", status: "idle", children: [
          { id: "thr_w", role: "writer · attempt 1", title: "Writer b1", status: "idle", children: [{ id: "thr_sub", role: "sub-agent", title: "Explore", status: "idle", children: [] }] },
        ] },
      }),
      retry_attempt: () => ({ ok: true }),
    } as never,
  });
}

describe("Lane Pilot tasks board", () => {
  it("shows every task and chain in its column and opens a card with the agents tree", async () => {
    const slot = await mount();
    await slot.findByTestId("board-columns");
    await waitFor(() => expect(slot.getByTestId("board-col-blocked").textContent).toContain("Title b1"));
    expect(slot.getByTestId("board-col-queued").textContent).toContain("Title q1");
    expect(slot.getByTestId("board-col-running").textContent).toMatch(/Insights post[\s\S]*chain/);
    expect(slot.getByTestId("board-col-done").textContent).toContain("Nothing here");

    fireEvent.click(slot.getByTestId("board-card-task:run:b1"));
    await slot.findByTestId("task-card");
    await waitFor(() => expect(slot.getByTestId("board-thread-thr_sub")).toBeTruthy());
    expect(slot.getByTestId("task-card").textContent).toMatch(/Fix the form[\s\S]*form saves/);
    fireEvent.click(slot.getByText("Retry"));
    await waitFor(() => expect(slot.rpcCalls.some((call) => call.method === "retry_attempt")).toBe(true));
    fireEvent.click(slot.getByTestId("board-back"));
    await slot.findByTestId("board-columns");
  });

  it("filters by kind and search", async () => {
    const slot = await mount();
    await waitFor(() => expect(slot.getByTestId("board-col-queued").textContent).toContain("Title q1"));
    fireEvent.change(slot.getByTestId("board-search"), { target: { value: "b1" } });
    expect(slot.getByTestId("board-col-queued").textContent).not.toContain("Title q1");
    expect(slot.getByTestId("board-col-blocked").textContent).toContain("Title b1");
  });
});
