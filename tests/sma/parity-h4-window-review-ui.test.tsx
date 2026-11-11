/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import { AcceptanceCard } from "../../src/rooms/acceptance/ui";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 20_000 });
beforeAll(() => { setLocaleOverride("en"); });
afterEach(() => { cleanup(); setLocaleOverride("en"); });

const batch = (id: string, pmThreadId: string | null) => ({
  kind: "batch", key: `batch:${id}`, runId: id, taskId: null, title: `Batch ${id}`, techTitle: id, taskKind: null, area: null, objective: null,
  projectId: "proj_a", pmThreadId, pmThreadTitle: null, column: "queued", state: "proposed", phase: "queued", stage: null, model: null, since: null,
  waitingFor: [], detail: null, attemptNo: 0, threadId: null, attemptId: null, updatedAt: 1_791_800_000_000, held: false, gates: null, wave: null,
});

describe("[review 6] a batch card with nothing to open", () => {
  it("is disabled without a PM thread and enabled with one", async () => {
    await loadPluginApp(() => import("../../app"));
    const { TaskBoard } = await import("../../src/rooms/runs/ui/task-board");
    const slot = await renderSlot({ component: () => <TaskBoard projects={[{ id: "proj_a", name: "Alpha" }]} locale="en" AcceptanceCard={AcceptanceCard} /> }, {}, {
      context: { projectId: null, threadId: null },
      rpc: { task_board: () => ({ items: [batch("dr_none", null), batch("dr_chat", "thr_pm")] }) } as never,
    });
    const dead = await slot.findByTestId("board-card-batch:dr_none");
    expect((dead as HTMLButtonElement).disabled).toBe(true);
    expect((slot.getByTestId("board-card-batch:dr_chat") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("[review 4] the worker card window figure from the stored limit event", () => {
  it("carries the Money screen's marker, and the loader is polled", async () => {
    await loadPluginApp(() => import("../../app"));
    const { WorkersScreen } = await import("../../src/rooms/cockpit/ui/screens-day");
    let reads = 0;
    const table: Record<string, unknown> = {
      cockpit_workers: () => [{ providerId: "claude-code", model: "m", tokens: 1, days: [], capabilities: [], running: 0, runningTasks: [], lastAt: null }],
      cockpit_windows: () => { reads += 1; return { at: "2026-11-11T10:20:00.000Z", limitEventAt: "2026-11-11T10:20:00.000Z", windows: { five_hour: { utilization: 99, resetsAt: null } } }; },
      cockpit_designer: () => ({ readiness: "ready", conditions: [], ratios: {} }),
    };
    const rpc = { call: (name: string, params: unknown) => Promise.resolve((table[name] as (p: unknown) => unknown)?.(params)) };
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const slot = await renderSlot({ component: () => <WorkersScreen rpc={rpc as never} projectId="p" hostId="h" /> }, {}, { context: { projectId: null, threadId: null }, rpc: table as never });
    const line = await slot.findByTestId("ck-worker-window");
    expect(line.textContent).toContain("99%");
    expect(line.textContent).toContain("from the last limit event");
    try {
      const before = reads;
      await vi.advanceTimersByTimeAsync(8_100);
      expect(reads).toBeGreaterThan(before);
    } finally { vi.useRealTimers(); }
  });
});
