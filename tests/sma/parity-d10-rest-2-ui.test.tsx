/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import type { ReactElement } from "react";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 20_000 });
beforeEach(() => { setLocaleOverride("ru"); });
afterEach(() => { cleanup(); setLocaleOverride("en"); Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); });

// The polls of the work graph (n919 attempt log tail every 8 s, n942 money_status every 30 s) run only while a cell is
// running and the page is shown; a finished task or a hidden tab makes no host call at all.
const graphOf = async (running: boolean) => (await import("../../src/rooms/work-graph")).taskGraph({
  events: running ? [{ stageId: "writer-agent", state: "running", at: 0 }] : [{ stageId: "writer-agent", state: "running", at: 0 }, { stageId: "writer-agent", state: "passed", at: 1 }],
  receipts: [{ stageId: "writer-agent", state: running ? "running" : "passed", threadId: "thr_w", providerId: "claude-code", model: "claude-sonnet-5-5", reason: null, updatedAt: 1 }],
  attempts: [{ id: "a1", no: 1, state: running ? "running" : "accepted", threadId: "thr_w", createdAt: 0, updatedAt: 1 }],
  usage: () => undefined, price: () => 0, turns: () => 1,
});
const mount = (element: () => ReactElement, rpc: Record<string, unknown>) => renderSlot({ component: element }, {}, { context: { projectId: null, threadId: null }, rpc: rpc as never });
async function ui() {
  await loadPluginApp(() => import("../../app"));
  return await import("../../src/rooms/work-graph/ui");
}

describe("work graph polls", () => {
  it("a running cell on a shown page reads the log tail (with the window's project) and the money status", async () => {
    const { StageSteps, WorkBreakdown } = await ui();
    const graph = await graphOf(true);
    const tail = vi.fn(() => ({ threadId: "thr_w", lines: ["читает файл…"] }));
    const money = vi.fn(() => ({ monthUsd: 1, cap: null }));
    const rpc = { work_graph_task: () => graph, attempt_log_tail: tail, money_status: money };
    const steps = mount(() => <StageSteps runId="run" taskId="t1" locale="ru" projectId="proj-a" />, rpc);
    await waitFor(() => expect(tail).toHaveBeenCalledWith({ runId: "run", taskId: "t1", projectId: "proj-a" }));
    steps.unmount();
    const breakdown = mount(() => <WorkBreakdown runId="run" taskId="t1" locale="ru" />, rpc);
    await waitFor(() => expect(money).toHaveBeenCalled());
    breakdown.unmount();
  });

  it("a finished task makes neither call", async () => {
    const { StageSteps, WorkBreakdown } = await ui();
    const graph = await graphOf(false);
    const tail = vi.fn(() => ({ threadId: null, lines: [] }));
    const money = vi.fn(() => ({ monthUsd: 1, cap: null }));
    const rpc = { work_graph_task: vi.fn(() => graph), attempt_log_tail: tail, money_status: money };
    const steps = mount(() => <StageSteps runId="run" taskId="t1" locale="ru" />, rpc);
    const breakdown = mount(() => <WorkBreakdown runId="run" taskId="t1" locale="ru" />, rpc);
    await waitFor(() => expect(rpc.work_graph_task).toHaveBeenCalled());
    await new Promise((done) => setTimeout(done, 150));
    expect(tail).not.toHaveBeenCalled();
    expect(money).not.toHaveBeenCalled();
    steps.unmount();
    breakdown.unmount();
  });

  it("a hidden page makes neither call even for a running cell", async () => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    const { StageSteps, WorkBreakdown } = await ui();
    const graph = await graphOf(true);
    const tail = vi.fn(() => ({ threadId: null, lines: [] }));
    const money = vi.fn(() => ({ monthUsd: 1, cap: null }));
    const rpc = { work_graph_task: vi.fn(() => graph), attempt_log_tail: tail, money_status: money };
    const steps = mount(() => <StageSteps runId="run" taskId="t1" locale="ru" />, rpc);
    const breakdown = mount(() => <WorkBreakdown runId="run" taskId="t1" locale="ru" />, rpc);
    await waitFor(() => expect(rpc.work_graph_task).toHaveBeenCalled());
    await new Promise((done) => setTimeout(done, 150));
    expect(tail).not.toHaveBeenCalled();
    expect(money).not.toHaveBeenCalled();
    steps.unmount();
    breakdown.unmount();
  });
});
