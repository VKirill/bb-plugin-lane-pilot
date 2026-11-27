/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { en, setLocaleOverride } from "@lane-pilot/i18n";
import { openTab } from "../ui-tabs";
import { projectId, mountWithBackend, choosePickerValue, scopedPicker, finish, type PickerNode } from "./helpers";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

/**
 * The host's picker reports the provider switch and then the model as two choices in a row, while the first save is still on its way.
 * Every picker but the writer's own used to send the second one with the versions it read before the first answered: a lost race
 * that reloaded the whole screen (every picker read «catalog loading» meanwhile), closed the popover and kept the first choice.
 */
describe("a second choice made while the first save of a role picker is in flight", () => {
  afterEach(() => {
    cleanup();
    setLocaleOverride(null);
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it("keeps the last choice of a role picker, saves it on the versions the first left, and does not reload the screen", async () => {
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const { harness, slot, specialistSaveCalls, screenCalls } = await mountWithBackend({
      delayRpc: async (method, input) => {
        // delayRpc holds the answer AFTER the hub wrote it and BEFORE the UI gets it: releasing is the delivery.
        if (method !== "save_specialist_selection") return;
        if ((input as { providerId: string }).providerId === "qwen") await new Promise<void>((resolve) => { releaseFirst = resolve; });
        else if ((input as { providerId: string }).providerId === "claude-code") await new Promise<void>((resolve) => { releaseSecond = resolve; });
      },
    });
    const picker = () => slot.getByTestId("specialist-settings").querySelector("[data-testid='bb-provider-model-picker']") as PickerNode;
    await waitFor(() => expect(picker().getAttribute("data-provider")).toBe("codex"));
    const screensBefore = screenCalls.length;
    const node = picker();
    await choosePickerValue({ providerId: "qwen", model: "qwen-test", reasoningLevel: "medium", serviceTier: "default" }, picker());
    await waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
    await choosePickerValue({ providerId: "claude-code", model: "claude-opus-5", reasoningLevel: "medium" }, picker());
    await act(async () => { releaseFirst!(); });
    await waitFor(() => expect(releaseSecond).toBeTypeOf("function"));
    await act(async () => { releaseSecond!(); });
    await waitFor(async () => {
      const current = await harness.behavior.callRpc("get_screen", { projectId }) as { values: Record<string, unknown> };
      expect(current.values).toMatchObject({ "specialist.provider": "claude-code", "specialist.model": "claude-opus-5" });
    });
    expect(specialistSaveCalls).toHaveLength(2);
    expect(specialistSaveCalls[1]!.expectedVersions).toEqual({ "specialist.provider": 1, "specialist.model": 1, "specialist.reasoning_effort": 1, "specialist.service_tier": 1 });
    expect(slot.queryByTestId("cas-conflict")).toBeNull();
    // Picker saves update local state in place rather than reloading the whole screen.
    expect(screenCalls).toHaveLength(screensBefore);
    expect(picker()).toBe(node);
    expect(picker().getAttribute("data-provider")).toBe("claude-code");
    // The role now has its own pair: «Same as level above» is live without a reload.
    expect(slot.getByTestId("loadout-reset-specialist_reviewer").textContent).toBe(en.consoleLoadoutResetLevelAbove);
    await finish(harness, slot);
  });

  it("shows the latest choice of a role picker at once, before any save has answered", async () => {
    let releaseFirst: (() => void) | undefined;
    const { harness, slot } = await mountWithBackend({
      delayRpc: async (method) => { if (method === "save_specialist_selection") await new Promise<void>((resolve) => { releaseFirst = resolve; }); },
    });
    const picker = () => slot.getByTestId("specialist-settings").querySelector("[data-testid='bb-provider-model-picker']") as PickerNode;
    await waitFor(() => expect(picker().getAttribute("data-provider")).toBe("codex"));
    await choosePickerValue({ providerId: "qwen", model: "qwen-test", reasoningLevel: "medium", serviceTier: "default" }, picker());
    await waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
    expect(picker().getAttribute("data-provider")).toBe("qwen");
    expect(picker().getAttribute("data-model")).toBe("qwen-test");
    releaseFirst!();
    await finish(harness, slot);
  });

  it("does the same for a writer fallback: both choices are saved in order and the last one stays", async () => {
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const { harness, slot, fallbackSaveCalls, screenCalls } = await mountWithBackend({
      delayRpc: async (method, input) => {
        if (method !== "save_writer_fallback_selection") return;
        if ((input as { providerId?: string }).providerId === "qwen") await new Promise<void>((resolve) => { releaseFirst = resolve; });
        else if ((input as { providerId?: string }).providerId === "claude-code") await new Promise<void>((resolve) => { releaseSecond = resolve; });
      },
    });
    fireEvent.click(slot.getByTestId("role-open-writer"));
    const picker = () => scopedPicker(slot, "writer-fallback-1");
    await waitFor(() => expect(picker()).toBeTruthy());
    const screensBefore = screenCalls.length;
    const node = picker();
    fireEvent.pointerDown(picker());
    await choosePickerValue({ providerId: "qwen", model: "qwen-test", reasoningLevel: "medium" }, picker());
    await waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
    await choosePickerValue({ providerId: "claude-code", model: "claude-opus-5", reasoningLevel: "medium" }, picker());
    expect(picker().getAttribute("data-provider")).toBe("claude-code");
    await act(async () => { releaseFirst!(); });
    await waitFor(() => expect(releaseSecond).toBeTypeOf("function"));
    await act(async () => { releaseSecond!(); });
    await waitFor(async () => {
      const current = await harness.behavior.callRpc("get_screen", { projectId }) as { values: Record<string, unknown> };
      expect(current.values).toMatchObject({ "writer.fallback1.provider": "claude-code", "writer.fallback1.model": "claude-opus-5" });
    });
    expect(fallbackSaveCalls.map((call) => call.providerId)).toEqual(["qwen", "claude-code"]);
    expect(fallbackSaveCalls[1]!.expectedVersions).toEqual({ "writer.fallback1.provider": 1, "writer.fallback1.model": 1, "writer.fallback1.reasoning_effort": 1 });
    expect(slot.queryByTestId("cas-conflict")).toBeNull();
    expect(screenCalls).toHaveLength(screensBefore);
    expect(picker()).toBe(node);
    expect(picker().getAttribute("data-provider")).toBe("claude-code");
    await finish(harness, slot);
  });

  it("catches a real full screen reload instead of just counting get_screen calls", async () => {
    const { harness, slot } = await mountWithBackend();
    const picker = () => slot.getByTestId("specialist-settings").querySelector("[data-testid='bb-provider-model-picker']") as PickerNode;
    await waitFor(() => expect(picker().getAttribute("data-provider")).toBe("codex"));
    const node = picker();
    // Test-harness limit: a forced remount replaces every node, which is only an analogue of a real reload —
    // it does not prove production load() or a real popover; it only proves the identity checks above are not vacuous.
    const app = await loadPluginApp(await import("../../app"));
    slot.lifecycle.rerender(createElement(app.navPanels[0]!.component, { key: "forced-remount", subPath: "" }));
    openTab(slot, "team");
    await waitFor(() => { const next = picker(); expect(next).toBeTruthy(); expect(next).not.toBe(node); });
    expect(picker().getAttribute("data-provider")).toBe("codex");
    await finish(harness, slot);
  });
});
