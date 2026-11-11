/** @vitest-environment jsdom */
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 20_000 });
beforeAll(() => { setLocaleOverride("en"); });
afterEach(() => { cleanup(); setLocaleOverride("en"); });

const rpcOf = (table: Record<string, unknown>) => ({ call: (name: string, params: unknown) => Promise.resolve((table[name] as (p: unknown) => unknown)?.(params)) });

async function mount(component: () => React.ReactElement, rpc: Record<string, unknown>) {
  await loadPluginApp(() => import("../../app"));
  return renderSlot({ component }, {}, { context: { projectId: null, threadId: null }, rpc: rpc as never });
}

const worker = (providerId: string) => ({ providerId, model: "m", tokens: 10, days: [{ day: "2026-11-11", tokens: 10 }], capabilities: [], running: 0, runningTasks: [], lastAt: null });

describe("[sma:m_sw_worker_card] the worker card names the live Claude window next to the model", () => {
  it("a claude-code card carries the window line; other providers do not", async () => {
    const { WorkersScreen } = await import("../../src/rooms/cockpit/ui/screens-day");
    const table = {
      cockpit_workers: () => [worker("claude-code"), worker("codex")],
      cockpit_windows: () => ({ at: "2026-11-11T00:00:00.000Z", windows: { five_hour: { utilization: 12.4, resetsAt: null }, seven_day: { utilization: 55.6, resetsAt: null } } }),
      cockpit_designer: () => ({ readiness: "ready", conditions: [], ratios: {} }),
    };
    const slot = await mount(() => <WorkersScreen rpc={rpcOf(table) as never} projectId="p" hostId="h" />, table);
    const cards = await slot.findAllByTestId("ck-worker-card");
    expect(cards).toHaveLength(2);
    const windowLine = cards[0]!.querySelector("[data-testid=ck-worker-window]");
    expect(windowLine?.textContent).toContain("12%");
    expect(windowLine?.textContent).toContain("56%");
    expect(cards[1]!.querySelector("[data-testid=ck-worker-window]")).toBeNull();
  });
});

describe("[sma:sc_acceptance] the acceptance card carries Stop", () => {
  it("the Stop press reaches onStop; without onStop there is no button", async () => {
    const { AcceptanceCard } = await import("../../src/rooms/acceptance/ui/acceptance-card");
    const calls: string[] = [];
    const rpc = { task_acceptance_card: () => null }; // gone → the card falls back to the task's own words
    const fallback = { objective: "Do the thing", acceptance: ["it is done"] };
    const slot = await mount(() => <AcceptanceCard runId="run" taskId="t1" refreshKey={0} finished={false} fallback={fallback} onStop={() => calls.push("t1")} />, rpc);
    const stop = await slot.findByTestId("acc-stop");
    fireEvent.click(stop);
    await waitFor(() => expect(calls).toEqual(["t1"]));
    cleanup();

    const bare = await mount(() => <AcceptanceCard runId="run" taskId="t1" refreshKey={0} finished={false} fallback={fallback} />, rpc);
    await bare.findByTestId("acceptance-card-fallback");
    expect(bare.queryByTestId("acc-stop")).toBeNull();
  });
});
