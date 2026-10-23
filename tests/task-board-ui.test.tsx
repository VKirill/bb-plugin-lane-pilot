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
  kind: "task", key: `task:run:${taskId}`, runId: "run", taskId, title: `Title ${taskId}`, techTitle: null, taskKind: "feature", area: "page:orders",
  objective: "Cakekeeper UI", projectId: "proj_a", pmThreadId: "thr_pm", pmThreadTitle: "Coordinator", column,
  state: column === "blocked" ? "blocked" : "running", phase: column === "blocked" ? "blocked" : column === "queued" ? "queued" : "writing",
  stage: null, model: null, since: null, waitingFor: [], detail: null, attemptNo: 1, threadId: null, attemptId: `a-${taskId}`, updatedAt: 1_791_800_000_000, ...extra,
});

async function mount() {
  const app = await loadPluginApp(() => import("../app"));
  void app;
  const { TaskBoard } = await import("../src/rooms/runs/ui/task-board");
  return renderSlot({ component: () => <TaskBoard projects={[{ id: "proj_a", name: "Alpha" }, { id: "proj_sb", name: "LP sandbox" }]} serviceProjectIds={["proj_sb"]} locale="en" /> }, {}, {
    context: { projectId: null, threadId: null },
    rpc: {
      task_board: () => ({ items: [
        item("ck-24-ui-pages-orders.2", "queued", { phase: "waiting", waitingFor: ["ck-23-ui-catalog-shell.2"], title: "Orders page" }),
        item("w1", "running", { stage: "writer-agent", model: "claude-opus-5-5", since: Date.now() - 6 * 60_000 }),
        item("b1", "blocked", { runId: "run2", key: "task:run2:b1", detail: "needs_human: may I?", taskKind: "fix", area: null, objective: "Login fixes" }),
        item("drill-1", "done", { projectId: "proj_sb", phase: "accepted", title: "Drill note" }),
        { ...item("", "running"), kind: "workflow", key: "workflow:wf1", runId: "wf1", taskId: null, title: "Insights post", taskKind: null, area: null, phase: "chain", stage: "collect", attemptId: null, objective: null, pmThreadId: null, pmThreadTitle: null }] }),
      task_card: () => ({
        kind: "task", title: "Title b1", techTitle: "Fix login form", taskKind: "fix", area: null, objective: "Login fixes", pmThreadId: "thr_pm",
        id: "b1", projectId: "proj_a", state: "blocked", reason: "needs_human: may I?",
        contract: { objective: "Fix the form", acceptance: ["form saves"], ownsPaths: ["a.ts"], expectedOutputs: [], dependsOn: [], checks: ["npm test"] }, plan: "1. edit",
        stages: [{ id: "plan-critique", state: "passed", reason: null, threadId: "thr_c", model: "opus", updatedAt: 1 }],
        attempts: [{ id: "a-b1", no: 1, state: "blocked", reason: "needs_human: may I?", threadId: "thr_w", createdAt: 1, updatedAt: 2 }],
        threads: { id: "thr_pm", role: "PM", title: "Coordinator", status: "idle", children: [
          { id: "thr_w", role: "writer#1", title: "Writer b1", status: "active", children: [{ id: "thr_sub", role: "sub-agent", title: "Explore", status: "idle", children: [] }] },
        ] },
      }),
      work_graph_task: () => ({
        cells: [{ stageId: "plan-critique", state: "passed", rounds: 1, failures: 0, reason: null }],
        stages: [{ cell: { stageId: "plan-critique", state: "passed", rounds: 1, failures: 0, reason: null },
          rows: [{ stageId: "plan-critique", role: "reviewer", round: 1, threadId: "thr_c", providerId: "claude-code", model: "opus", seconds: 30, tokens: null, costUsd: null, costState: "not_measured", turns: 2 }] }],
        summary: { returns: 0, seconds: 30, costUsd: null, costState: "not_measured", models: ["opus"] },
      }),
      work_graph_strips: () => ({}),
      retry_attempt: () => ({ ok: true }),
    } as never,
  });
}

describe("Lane Pilot tasks board", () => {
  it("shows every task and chain in its column and opens a card with the agents tree", async () => {
    const slot = await mount();
    await slot.findByTestId("board-columns");
    await waitFor(() => expect(slot.getByTestId("board-col-blocked").textContent).toContain("Title b1"));
    // Tracker-like key, what it waits for, the live stage with its model, the kind chip; drills are hidden by default.
    expect(slot.getByTestId("board-col-queued").textContent).toMatch(/ck-24\.2[\s\S]*waits for ck-23\.2[\s\S]*Orders page[\s\S]*Feature[\s\S]*orders/);
    expect(slot.getByTestId("board-col-running").textContent).toMatch(/writing · opus-5-5 · 6 min[\s\S]*Title w1/);
    expect(slot.getByTestId("board-col-running").textContent).toMatch(/Insights post/);
    expect(slot.getByTestId("board-col-blocked").textContent).toContain("Fix");
    expect(slot.getByTestId("board-col-done").textContent).toContain("Nothing here");
    fireEvent.click(slot.getByTestId("board-drills"));
    await waitFor(() => expect(slot.getByTestId("board-col-done").textContent).toContain("Drill note"));

    fireEvent.click(slot.getByTestId("board-card-task:run2:b1"));
    await slot.findByTestId("task-card");
    await waitFor(() => expect(slot.getByTestId("board-thread-thr_sub")).toBeTruthy());
    expect(slot.getByTestId("task-card").textContent).toMatch(/Goal[\s\S]*Login fixes[\s\S]*Title b1[\s\S]*Fix the form[\s\S]*form saves/);
    expect(slot.getByTestId("board-thread-thr_w").textContent).toContain("Writer · attempt 1");
    expect(slot.getByTestId("task-card").textContent).toMatch(/Plan critique[\s\S]*1 working now/);
    fireEvent.click(slot.getByText("Retry"));
    await waitFor(() => expect(slot.rpcCalls.some((call) => call.method === "retry_attempt")).toBe(true));
    fireEvent.click(slot.getByTestId("board-back"));
    await slot.findByTestId("board-columns");
  });

  it("filters by search and lists tasks grouped by goal", async () => {
    const slot = await mount();
    await waitFor(() => expect(slot.getByTestId("board-col-queued").textContent).toContain("Orders page"));
    fireEvent.change(slot.getByTestId("board-search"), { target: { value: "b1" } });
    expect(slot.getByTestId("board-col-queued").textContent).not.toContain("Orders page");
    expect(slot.getByTestId("board-col-blocked").textContent).toContain("Title b1");
    fireEvent.change(slot.getByTestId("board-search"), { target: { value: "" } });
    fireEvent.click(slot.getByTestId("board-view-list"));
    const list = await slot.findByTestId("board-list");
    expect(list.textContent).toMatch(/Cakekeeper UI[\s\S]*Orders page/);
    expect(list.textContent).toMatch(/Login fixes[\s\S]*Title b1/);
  });
});
