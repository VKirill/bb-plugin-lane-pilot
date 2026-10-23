/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import type { ReactElement } from "react";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 20_000 });
beforeEach(() => { setLocaleOverride("ru"); });
afterEach(() => { cleanup(); setLocaleOverride("en"); });

const makeGraph = async () => (await import("../src/rooms/work-graph")).taskGraph({
  events: [{ stageId: "writer-agent", state: "running", at: 0 }, { stageId: "writer-agent", state: "failed", at: 1 }, { stageId: "writer-agent", state: "running", at: 2 }, { stageId: "writer-agent", state: "passed", at: 3 }],
  receipts: [
    { stageId: "writer-agent", state: "passed", threadId: "thr_w", providerId: "claude-code", model: "claude-sonnet-5-5", reason: null, updatedAt: 3 },
    { stageId: "plan-critique", state: "passed", threadId: "thr_c", providerId: "acp-cursor", model: "composer-2.5", reason: null, updatedAt: 1 },
  ],
  attempts: [{ id: "a1", no: 1, state: "accepted", threadId: "thr_w", createdAt: 0, updatedAt: 2_820_000 }],
  usage: (threadId) => (threadId === "thr_w" ? { providerId: "claude-code", model: "claude-sonnet-5-5", billed: { fresh: 22, cacheRead: 587_500, cacheWrite: 52_800, output: 4_200 } } : undefined),
  price: () => 0.42, turns: () => 3,
});
let graph: Awaited<ReturnType<typeof makeGraph>>;

async function ui() {
  await loadPluginApp(() => import("../app"));
  graph = await makeGraph();
  return await import("../src/rooms/work-graph/ui");
}
const mount = (element: () => ReactElement, rpc: Record<string, unknown>) => renderSlot({ component: element }, {}, { context: { projectId: null, threadId: null }, rpc: rpc as never });

describe("the work graph screens", () => {
  it("a task's run: the cells with the retry count, who ran each stage, tokens in the owner's units, not measured stays not measured", async () => {
    const { WorkBreakdown } = await ui();
    const view = mount(() => <WorkBreakdown runId="run" taskId="t1" locale="ru" />, { work_graph_task: () => graph });
    await view.findByTestId("work-breakdown");
    const writer = view.getByTestId("graph-row-writer-agent-1");
    expect(writer.textContent).toContain("исполнитель");
    expect(writer.textContent).toContain("sonnet-5-5");
    expect(writer.textContent).toContain("587,5 тыс");
    expect(writer.textContent).toContain("47 м");
    expect(writer.textContent).toContain("$0.420");
    expect(view.getByTestId("graph-row-plan-critique-1").textContent).toContain("не измерено");
    expect(view.getAllByTestId("stage-strip")[0]!.querySelector('[data-stage="writer-agent"]')!.textContent).toBe("2");
    expect(view.getByText("Возвраты: 1")).toBeTruthy();
  });

  it("stages and models: the stage table, and per model the green or the blocking share", async () => {
    const { StageModelStats } = await ui();
    const { graphStats } = await import("../src/rooms/work-graph");
    const calls: unknown[] = [];
    const view = mount(() => <StageModelStats locale="ru" excludeProjectIds={["proj_sandbox"]} />, {
      work_graph_stats: (input: unknown) => { calls.push(input); return { days: 30, capped: false, ...graphStats([graph, graph]) }; },
    });
    await view.findByTestId("graph-stage-table");
    expect(view.getByTestId("graph-stat-writer-agent").textContent).toContain("100%");
    expect(view.getAllByTestId("graph-model-plan-critique")[0]!.textContent).toContain("0% блокирующих");
    expect(calls[0]).toEqual({ days: 30, excludeProjectIds: ["proj_sandbox"] });
    fireEvent.click(view.getByTestId("graph-days"));
    await waitFor(() => expect(view.getByTestId("graph-stage-table")).toBeTruthy());
  });
});
