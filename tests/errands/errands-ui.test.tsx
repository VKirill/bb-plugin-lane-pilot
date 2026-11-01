/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { en, ru, setLocaleOverride } from "@lane-pilot/i18n";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 30_000 });
beforeAll(() => { setLocaleOverride("en"); });
afterEach(() => { cleanup(); setLocaleOverride("en"); });

const NOW = 1_800_000_000_000;
const kind = (id: string, role: string, extra: Record<string, unknown> = {}) => ({ kind: id, role, providerId: "claude-code", model: "claude-opus-5-5", effort: "high", source: "default", runs: 0, done: 0, blocked: 0, failed: 0, costUsd: 0, jevWouldPick: 0, ...extra });
const payload = () => ({
  days: 7,
  kinds: [kind("computer", "errand-computer", { runs: 2, done: 1, blocked: 1, costUsd: 0.75, source: "table" }), kind("devops", "errand-devops"), kind("browser", "errand-browser"), kind("research", "errand-research"), kind("message", "errand"), kind("none", "errand", { runs: 1, failed: 1 })],
  errands: [
    { id: "wf_1", projectId: "p1", title: "Record the Studio screen", kind: "computer", kindBy: "hint", providerId: "claude-code", model: "claude-opus-5-5", outcome: "done", reason: "", source: { type: "pm", threadId: "thr_pm" }, threadId: "thr_helper", tokens: 1000, costUsd: 0.5, startedAt: NOW, endedAt: NOW + 1 },
    { id: "wf_2", projectId: "p1", title: "Rent a GPU", kind: "none", kindBy: "", providerId: "", model: "glm-5.3-flash", outcome: "canceled", reason: "canceled by owner", source: { type: "schedule", name: "" }, threadId: null, tokens: 0, costUsd: 0, startedAt: NOW - 1000, endedAt: NOW },
  ],
});

async function mount(rpc: Record<string, unknown>) {
  await loadPluginApp(() => import("../../app"));
  const { ErrandsScreen } = await import("../../src/rooms/errands/ui");
  return renderSlot({ component: () => <ErrandsScreen projects={[{ id: "p1", name: "Studio" }]} locale="en" /> }, {}, { context: { projectId: null, threadId: null }, rpc: rpc as never });
}

describe("the Errands page", () => {
  it("shows every kind with its model and row, and the period's errands with outcome, source and a button to the helper's chat", async () => {
    const slot = await mount({ errands_overview: () => payload() });
    await slot.findByTestId("errands-table");
    expect(slot.getByTestId("errand-kinds-table").querySelectorAll("tbody tr")).toHaveLength(6);
    expect(slot.getByTestId("errand-kind-computer").textContent).toContain("claude-opus-5-5");
    expect(slot.getByTestId("errand-kind-computer").textContent).toContain("errand-computer");
    expect(slot.getByTestId("errand-kind-computer").textContent).toContain(en.er_model_owner);
    const rows = slot.getAllByTestId("errand-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Record the Studio screen");
    expect(rows[0]!.textContent).toContain(en.er_out_done);
    expect(rows[0]!.textContent).toContain(en.er_src_pm);
    expect(rows[0]!.textContent).toContain("Studio");
    expect(rows[1]!.textContent).toContain(en.er_out_canceled);
    expect(rows[1]!.textContent).toContain(en.er_src_schedule_gone);
    expect(slot.getAllByTestId("errand-open")).toHaveLength(1);
    slot.lifecycle.unmount();
  });

  it("filters the list by kind and asks the server again for another period", async () => {
    const calls: unknown[] = [];
    const slot = await mount({ errands_overview: (input: unknown) => { calls.push(input); return payload(); } });
    await slot.findByTestId("errands-table");
    fireEvent.click(slot.getByTestId("seg-errand-kind-filter-none"));
    await waitFor(() => expect(slot.getAllByTestId("errand-row")).toHaveLength(1));
    expect(slot.getAllByTestId("errand-row")[0]!.getAttribute("data-kind")).toBe("none");
    fireEvent.click(slot.getByTestId("seg-errand-days-30"));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({ days: 30 });
    slot.lifecycle.unmount();
  });

  it("speaks Russian", async () => {
    setLocaleOverride("ru");
    const slot = await mount({ errands_overview: () => payload() });
    await slot.findByTestId("errands-table");
    expect(slot.getByTestId("errands-screen").textContent).toContain(ru.er_title);
    expect(slot.getByTestId("errand-kind-computer").textContent).toContain(ru.er_kind_computer);
    expect(slot.getAllByTestId("errand-row")[0]!.textContent).toContain(ru.er_out_done);
    slot.lifecycle.unmount();
  });
});
