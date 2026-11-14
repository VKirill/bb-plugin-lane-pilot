/** @vitest-environment jsdom */
// The tails batch, the UI node: n835 «Running check» (SMA m_sw_check_run) — the check's stages and a stop button.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import { AcceptanceCard } from "../../src/rooms/acceptance/ui";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 30_000 });
beforeAll(() => { setLocaleOverride("en"); });
afterEach(() => { cleanup(); setLocaleOverride("en"); });

type Table = Record<string, (params: never) => unknown>;
const item = (taskId: string, column: string, extra: Record<string, unknown> = {}) => ({
  kind: "task", key: `task:run:${taskId}`, runId: "run", taskId, title: `Title ${taskId}`, techTitle: null, taskKind: "feature", area: null,
  objective: "Check the form", projectId: "proj_a", pmThreadId: "thr_pm", pmThreadTitle: "Coordinator", column,
  state: column === "done" ? "accepted" : "running", phase: column === "done" ? "accepted" : column,
  stage: null, model: null, since: null, waitingFor: [], detail: null, attemptNo: 1, threadId: null, attemptId: `a-${taskId}`, updatedAt: 1_791_800_000_000, ...extra,
});
const card = (id: string, state: string) => ({
  kind: "task", title: `Title ${id}`, techTitle: null, taskKind: "feature", area: null, objective: "Check the form", pmThreadId: "thr_pm", id, projectId: "proj_a", state, reason: null,
  contract: { objective: "Fix the form", acceptance: ["form saves"], ownsPaths: ["a.ts"], expectedOutputs: [], dependsOn: [], checks: ["npm test"] }, plan: "1. edit",
  stages: [], attempts: [{ id: `a-${id}`, no: 1, state, reason: null, threadId: "thr_w", createdAt: 1, updatedAt: 2 }], threads: null,
});
const cell = (stageId: string, state: string) => ({ stageId, state, rounds: state === "pending" ? 0 : 1, failures: 0, reason: null });
const graph = {
  cells: [cell("writer-agent", "passed"), cell("code-critique", "running")],
  stages: [
    { cell: cell("writer-agent", "passed"), rows: [{ stageId: "writer-agent", role: "writer", round: 1, threadId: "thr_w", providerId: "p", model: "composer-2.5", seconds: null, tokens: null, costUsd: null, costState: "not_measured", turns: 3 }] },
    { cell: cell("code-critique", "running"), rows: [{ stageId: "code-critique", role: "code-critic", round: 1, threadId: "thr_c", providerId: "p", model: "composer-2.5", seconds: null, tokens: null, costUsd: null, costState: "not_measured", turns: 5 }] },
  ],
  summary: { returns: 0, seconds: null, costUsd: null, costState: "not_measured", models: [] },
};

async function board(items: unknown[], extra: Table = {}) {
  await loadPluginApp(() => import("../../app"));
  const { TaskBoard } = await import("../../src/rooms/runs/ui/task-board");
  const calls: Array<[string, unknown]> = [];
  const wrap = (name: string, handler: (params: never) => unknown) => (params: never) => { calls.push([name, params]); return handler(params); };
  const table: Table = {
    task_board: () => ({ items }), task_card: ({ taskId }: { taskId: string }) => card(taskId, "running"), task_acceptance_card: () => null,
    work_graph_task: () => graph, work_graph_strips: () => ({}), task_diff: () => ({ reason: "no merge" }), work_file_read: () => ({ content: "", truncated: false }), ...extra,
  };
  const wrapped = Object.fromEntries(Object.entries(table).map(([name, handler]) => [name, wrap(name, handler)]));
  const slot = renderSlot({ component: () => <TaskBoard projects={[{ id: "proj_a", name: "Alpha" }]} serviceProjectIds={[]} locale="en" AcceptanceCard={AcceptanceCard} /> }, {}, { context: { projectId: null, threadId: null }, rpc: wrapped as never });
  return { slot, calls, of: (name: string) => calls.filter(([method]) => method === name).map(([, params]) => params) };
}

describe("tails · the running check", () => {
  it("[sma:m_sw_check_run] a task in its check shows the check's stages (the finished writer, the critic still running) and a Cancel button that stops its attempt; a done task has no Cancel", async () => {
    const stopped: unknown[] = [];
    const { slot, of } = await board([item("c1", "checking", { stage: "code-critique", model: "composer-2.5" }), item("d1", "done")], { cancel_attempt: (params: unknown) => { stopped.push(params); return { ok: true }; } });
    await waitFor(() => expect(slot.getByTestId("board-col-checking").textContent).toContain("Title c1"));
    expect(slot.getByTestId("board-col-done").textContent).toContain("Title d1");
    fireEvent.click(slot.getByTestId("board-card-task:run:c1"));
    await slot.findByTestId("task-card");
    const cancel = await slot.findByText("Cancel", { selector: "button" });
    expect(of("work_graph_task")).toContainEqual({ runId: "run", taskId: "c1" });
    fireEvent.click(cancel);
    await waitFor(() => expect(stopped).toEqual([{ attemptId: "a-c1" }]));
    fireEvent.click(slot.getByTestId("board-back"));
    fireEvent.click(await slot.findByTestId("board-card-task:run:d1"));
    await slot.findByTestId("task-card");
    expect(slot.queryByText("Cancel", { selector: "button" })).toBeNull();
  });

  it("[sma:m_sw_check_run] the thread's live panel names a check at work by its phase and stage, and a click opens its steps one per stage", async () => {
    await loadPluginApp(() => import("../../app"));
    const { ThreadLive } = await import("../../src/rooms/runs/ui");
    const live = { role: "pm", pmThreadId: "thr_pm", items: [item("c1", "checking", { stage: "code-critique", model: "composer-2.5", since: Date.now() - 4 * 60_000 })],
      strips: { "run:c1": { cells: graph.cells, summary: {} } } };
    const view = renderSlot({ component: () => <ThreadLive threadId="thr_pm" locale="en" /> }, {}, { context: { projectId: null, threadId: null }, rpc: { thread_live: () => live, work_graph_task: () => graph } as never });
    await view.findByTestId("thread-live");
    const line = view.getByTestId("live-task-task:run:c1").querySelector("span.truncate")!.textContent;
    expect(line).toBe("checks · Code critique · composer-2.5 · 4 min");
    await view.findByTestId("stage-steps");
    expect(view.getByTestId("step-writer-agent")).toBeTruthy();
    expect(view.getByTestId("step-code-critique").textContent).toContain("turns 5");
  });
});
