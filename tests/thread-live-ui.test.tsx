/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 20_000 });
beforeEach(() => { setLocaleOverride("ru"); });
afterEach(() => { cleanup(); setLocaleOverride("en"); });

const item = (taskId: string, column: string, phase: string, extra: Record<string, unknown> = {}) => ({
  key: `task:run:${taskId}`, runId: "run", taskId, title: `Задача ${taskId}`, column, phase, stage: null, model: null, since: null, threadId: null, updatedAt: 1, detail: null, ...extra,
});
const cell = (stageId: string, state: string) => ({ stageId, state, rounds: state === "pending" ? 0 : 1, failures: 0, reason: null });

describe("Lane Pilot in the thread's info panel", () => {
  it("shows the task at work with its stage, model and steps, and the week's tasks; nothing for a foreign thread", async () => {
    await loadPluginApp(() => import("../app"));
    const { ThreadLive } = await import("../src/rooms/runs/ui");
    const live = {
      role: "pm", pmThreadId: "thr_pm",
      items: [item("w1", "running", "writing", { stage: "writer-agent", model: "composer-2.5", since: Date.now() - 12 * 60_000, threadId: "thr_w" }), item("d1", "done", "accepted")],
      strips: { "run:w1": { cells: [cell("writer-agent", "running")], summary: {} }, "run:d1": { cells: [cell("writer-agent", "passed")], summary: {} } },
    };
    const graph = { cells: [cell("writer-agent", "running")], stages: [{ cell: cell("writer-agent", "running"), rows: [{ stageId: "writer-agent", role: "writer", round: 1, threadId: "thr_w", providerId: "acp-cursor", model: "composer-2.5", seconds: null, tokens: null, costUsd: null, costState: "not_measured", turns: 3 }] }], summary: { returns: 0, seconds: null, costUsd: null, costState: "not_measured", models: [] } };
    const view = renderSlot({ component: () => <ThreadLive threadId="thr_pm" locale="ru" /> }, {}, { context: { projectId: null, threadId: null }, rpc: { thread_live: () => live, work_graph_task: () => graph } as never });
    await view.findByTestId("thread-live");
    expect(view.getByTestId("thread-live").textContent).toMatch(/в работе 1 · готово 1 из 2[\s\S]*Сейчас[\s\S]*Задача w1[\s\S]*пишет · Исполнитель · composer-2.5 · 12 мин[\s\S]*За неделю[\s\S]*Задача d1/);
    await view.findByTestId("stage-steps");
    expect(view.getByTestId("step-writer-agent").textContent).toContain("ходы 3");
    fireEvent.click(view.getByText("Задача d1"));
    await waitFor(() => expect(view.getAllByTestId("stage-steps")).toHaveLength(2));

    cleanup();
    const empty = renderSlot({ component: () => <ThreadLive threadId="thr_x" locale="ru" /> }, {}, { context: { projectId: null, threadId: null }, rpc: { thread_live: () => null } as never });
    await waitFor(() => expect(empty.rpcCalls.some((call) => call.method === "thread_live")).toBe(true));
    expect(empty.queryByTestId("thread-live")).toBeNull();
  });
});
