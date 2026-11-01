/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { en, ru, setLocaleOverride } from "@lane-pilot/i18n";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { choosePickerValue, installPickerTestDriver, scopedPicker } from "../ui-settings-integration/helpers";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 30_000 });
beforeAll(() => { setLocaleOverride("en"); });
afterEach(() => { cleanup(); setLocaleOverride("en"); });

const NOW = 1_800_000_000_000;
const kind = (id: string, role: string, extra: Record<string, unknown> = {}) => ({ kind: id, role, providerId: "claude-code", model: "claude-opus-5-5", effort: "high", source: "default", runs: 0, done: 0, blocked: 0, failed: 0, costUsd: 0, jevWouldPick: 0, ...extra });
const payload = () => ({
  days: 7,
  kinds: [kind("computer", "errand-computer", { runs: 2, done: 1, blocked: 1, costUsd: 0.75, source: "table" }), kind("devops", "errand-devops"), kind("browser", "errand-browser"), kind("research", "errand-research"), kind("message", "errand", { model: "glm-5.3-flash", providerId: "opencode2" }), kind("none", "errand", { runs: 1, failed: 1, model: "glm-5.3-flash", providerId: "opencode2" })],
  errands: [
    { id: "wf_1", projectId: "p1", title: "Record the Studio screen", kind: "computer", kindBy: "hint", providerId: "claude-code", model: "claude-opus-5-5", outcome: "done", reason: "", source: { type: "pm", threadId: "thr_pm" }, threadId: "thr_helper", tokens: 1000, costUsd: 0.5, startedAt: NOW, endedAt: NOW + 1 },
    { id: "wf_2", projectId: "p1", title: "Rent a GPU", kind: "none", kindBy: "", providerId: "", model: "glm-5.3-flash", outcome: "canceled", reason: "canceled by owner", source: { type: "schedule", name: "Rent a GPU" }, threadId: null, tokens: 0, costUsd: 0, startedAt: NOW - 1000, endedAt: NOW },
    { id: "wf_3", projectId: "p1", title: "Blender over MCP", kind: "devops", kindBy: "pm", providerId: "claude-code", model: "claude-opus-5-5", outcome: "failed", reason: "step_failed:work", source: { type: "schedule", name: "" }, threadId: null, tokens: 0, costUsd: 0, startedAt: NOW - 2000, endedAt: NOW },
  ],
});
const catalog = {
  hosts: [{ id: "mini", name: "Mac mini", connected: true }],
  providers: [
    { id: "claude-code", displayName: "Claude Code", logoUrl: null, family: null, supportsServiceTier: false, serviceTiers: [], hostIds: ["mini"], models: [
      { id: "claude-opus-5-5", model: "claude-opus-5-5", displayName: "Opus 5.5", efforts: ["low", "medium", "high"], defaultEffort: "high", isDefault: true, hostIds: ["mini"] },
      { id: "claude-sonnet-5-5", model: "claude-sonnet-5-5", displayName: "Sonnet 5.5", efforts: ["low", "medium", "high"], defaultEffort: "medium", isDefault: false, hostIds: ["mini"] }] },
    { id: "acp-cursor", displayName: "Cursor", logoUrl: null, family: null, supportsServiceTier: false, serviceTiers: [], hostIds: ["mini"], models: [
      { id: "grok-4.6", model: "grok-4.6", displayName: "Grok 4.6", efforts: ["medium", "high"], defaultEffort: "medium", isDefault: true, hostIds: ["mini"] }] },
  ],
  runHostId: "mini",
};
const roleRow = (role: string, extra: Record<string, unknown> = {}) => ({ role, providerId: "claude-code", model: "claude-opus-5-5", effort: "high", source: "default", sourceKey: null, own: false, version: 0, defaultModel: "claude-opus-5-5", defaultEffort: "high", offered: true, pool: [], ...extra });
const roles = () => ({ roles: [roleRow("errand-computer", { own: true, version: 2, source: "table", pool: [{ providerId: "claude-code", model: "claude-sonnet-5-5", effort: null }] }), roleRow("errand-devops"), roleRow("errand-browser"), roleRow("errand-research"), roleRow("errand", { providerId: "opencode2", model: "glm-5.3-flash" })], options: [] });

async function mount(rpc: Record<string, unknown>) {
  installPickerTestDriver();
  await loadPluginApp(() => import("../../app"));
  const { ErrandsScreen } = await import("../../src/rooms/errands/ui");
  return renderSlot({ component: () => <ErrandsScreen projects={[{ id: "p1", name: "Studio" }]} locale="en" /> }, {}, { context: { projectId: null, threadId: null }, rpc: rpc as never });
}
const baseRpc = (saves: unknown[] = []) => ({ errands_overview: () => payload(), get_role_models: () => roles(), workflow_model_catalog: () => catalog, save_setting: (input: unknown) => { saves.push(input); return { ok: true, conflict: false, version: 3, value: (input as { value: unknown }).value }; } });

describe("the Errands page", () => {
  it("shows every kind with BB's model window on its role row, the model's display name, and the period's errands with plain outcomes and sources", async () => {
    const slot = await mount(baseRpc());
    await slot.findByTestId("errands-table");
    await waitFor(() => expect(scopedPicker(slot, "errand-model-pick-computer")).toBeTruthy());
    expect(scopedPicker(slot, "errand-model-pick-computer").getAttribute("data-model")).toBe("claude-opus-5-5");
    expect(slot.getByTestId("errand-kind-computer").textContent).toContain(en.er_model_owner);
    expect(slot.getByTestId("errand-model-reset-computer")).toBeTruthy();
    expect(slot.getByTestId("errand-kind-devops").textContent).toContain(en.er_model_builtin);
    // Two kinds on one row of the table get one window; the second says whose model it shares.
    expect(slot.queryByTestId("errand-model-pick-none")).toBeNull();
    expect(slot.getByTestId("errand-model-same-none").textContent).toBe(en.er_same_row.replace("{kind}", en.er_kind_message));
    const rows = slot.getAllByTestId("errand-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain("Opus 5.5");
    expect(rows[0]!.textContent).not.toContain("claude-opus-5-5");
    expect(rows[0]!.textContent).toContain(en.er_out_done);
    expect(rows[0]!.textContent).toContain(en.er_src_pm);
    expect(rows[0]!.textContent).toContain("Studio");
    // Technical reasons come out in plain words, and a schedule named after the errand is just «schedule».
    expect(rows[1]!.querySelector("[data-testid='errand-reason']")!.textContent).toBe(en.er_why_canceled);
    expect(rows[1]!.textContent).toContain(en.er_src_schedule_plain);
    expect(rows[1]!.textContent).not.toContain("canceled by owner");
    expect(rows[2]!.querySelector("[data-testid='errand-reason']")!.textContent).toBe(en.er_why_work);
    expect(rows[2]!.textContent).toContain(en.er_src_schedule_gone);
    expect(slot.getAllByTestId("errand-open")).toHaveLength(1);
    slot.lifecycle.unmount();
  });

  it("a choice in the window is saved as the role's row at the global level with its version, the pool kept; «back to default» drops the row", async () => {
    const saves: Array<{ key: string; projectId: string; value: unknown; expectedVersion: number }> = [];
    const slot = await mount(baseRpc(saves));
    await slot.findByTestId("errands-table");
    await waitFor(() => expect(scopedPicker(slot, "errand-model-pick-computer")).toBeTruthy());
    await choosePickerValue({ providerId: "acp-cursor", model: "grok-4.6", reasoningLevel: "medium" }, scopedPicker(slot, "errand-model-pick-computer"));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toMatchObject({ projectId: GLOBAL_SETTINGS_PROJECT_ID, key: "role_model.errand-computer", expectedVersion: 2,
      value: { provider: "acp-cursor", model: "grok-4.6", reasoning_effort: "medium", pool: [{ provider: "claude-code", model: "claude-sonnet-5-5" }] } });
    fireEvent.click(slot.getByTestId("errand-model-reset-computer"));
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1]).toMatchObject({ key: "role_model.errand-computer", value: null });
    slot.lifecycle.unmount();
  });

  it("filters the list by kind and asks the server again for another period", async () => {
    const calls: unknown[] = [];
    const slot = await mount({ ...baseRpc(), errands_overview: (input: unknown) => { calls.push(input); return payload(); } });
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
    const slot = await mount(baseRpc());
    await slot.findByTestId("errands-table");
    expect(slot.getByTestId("errands-screen").textContent).toContain(ru.er_title);
    expect(slot.getByTestId("errand-kind-computer").textContent).toContain(ru.er_kind_computer);
    expect(slot.getAllByTestId("errand-row")[1]!.querySelector("[data-testid='errand-reason']")!.textContent).toBe(ru.er_why_canceled);
    slot.lifecycle.unmount();
  });
});
