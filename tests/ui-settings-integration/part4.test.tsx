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
        if (method !== "save_specialist_selection") return;
        // delayRpc holds the answer AFTER the hub wrote it and BEFORE the UI gets it: releasing is the delivery.
        if ((input as { providerId: string }).providerId === "qwen") await new Promise<void>((resolve) => { releaseFirst = resolve; });
        else if ((input as { providerId: string }).providerId === "claude-code") await new Promise<void>((resolve) => { releaseSecond = resolve; });
      },
    });
    const picker = () => slot.getByTestId("specialist-settings").querySelector("[data-testid='bb-provider-model-picker']") as PickerNode;
    await waitFor(() => expect(picker().getAttribute("data-provider")).toBe("codex"));
    const screensBefore = screenCalls.length;
    const node = picker();
    // Hold every post-mount get_screen response; each held call keeps its own promise token so the exact
    // response can be awaited by name instead of inferred from call order or counts.
    const releaseScreens: Array<() => void> = [];
    const heldResponses: Promise<unknown>[] = [];
    const originalCall = harness.behavior.callRpc.bind(harness.behavior);
    harness.behavior.callRpc = (async (method: string, input: unknown) => {
      if (method !== "get_screen") return originalCall(method, input);
      const held = new Promise<void>((resolve) => releaseScreens.push(resolve)).then(() => originalCall(method, input));
      heldResponses.push(held);
      return held;
    }) as typeof harness.behavior.callRpc;
    await choosePickerValue({ providerId: "qwen", model: "qwen-test", reasoningLevel: "medium", serviceTier: "default" }, picker());
    await waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
    await choosePickerValue({ providerId: "claude-code", model: "claude-opus-5", reasoningLevel: "medium" }, picker());
    // Deliver the first save inside act while the second stays held; a gate release is not a commit.
    await act(async () => { releaseFirst!(); });
    // Drain whatever the first settle triggered, so the boundary below is stable.
    await act(async () => {
      for (const release of releaseScreens.splice(0)) release();
      await Promise.all(heldResponses);
    });
    await waitFor(() => expect(releaseSecond).toBeTypeOf("function"));
    const heldBefore = heldResponses.length;
    // Deliver the second save; only a get_screen issued after this delivery satisfies the barrier.
    await act(async () => { releaseSecond!(); });
    await waitFor(() => expect(heldResponses.length).toBeGreaterThan(heldBefore));
    const finalRefresh = heldResponses[heldResponses.length - 1]!;
    await act(async () => {
      for (const release of releaseScreens.splice(0)) release();
      await finalRefresh;
      await Promise.all(heldResponses);
    });
    expect(releaseScreens).toHaveLength(0);
    await waitFor(async () => {
      const current = await originalCall("get_screen", { projectId }) as { values: Record<string, unknown> };
      expect(current.values).toMatchObject({ "specialist.provider": "claude-code", "specialist.model": "claude-opus-5" });
    });
    expect(specialistSaveCalls).toHaveLength(2);
    expect(specialistSaveCalls[1]!.expectedVersions).toEqual({ "specialist.provider": 1, "specialist.model": 1, "specialist.reasoning_effort": 1, "specialist.service_tier": 1 });
    expect(slot.queryByTestId("cas-conflict")).toBeNull();
    // The diagnostic refresh ran to completion after the second save; the picker's DOM node must be the same
    // element — a real load() would blank the screen to «Loading the project…» and come back with a new node.
    expect(screenCalls.length).toBeGreaterThan(screensBefore);
    expect(picker()).toBe(node);
    expect(picker().getAttribute("data-provider")).toBe("claude-code");
    // The role now has its own pair: the row says so and «Вернуть унаследованное» is live without a reload.
    expect(slot.getByTestId("role-origin-specialist_reviewer").textContent).toBe(en.accessOrigin_project);
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
    const releaseScreens: Array<() => void> = [];
    const heldResponses: Promise<unknown>[] = [];
    const originalCall = harness.behavior.callRpc.bind(harness.behavior);
    harness.behavior.callRpc = (async (method: string, input: unknown) => {
      if (method !== "get_screen") return originalCall(method, input);
      const held = new Promise<void>((resolve) => releaseScreens.push(resolve)).then(() => originalCall(method, input));
      heldResponses.push(held);
      return held;
    }) as typeof harness.behavior.callRpc;
    fireEvent.pointerDown(picker());
    await choosePickerValue({ providerId: "qwen", model: "qwen-test", reasoningLevel: "medium" }, picker());
    await waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
    await choosePickerValue({ providerId: "claude-code", model: "claude-opus-5", reasoningLevel: "medium" }, picker());
    expect(picker().getAttribute("data-provider")).toBe("claude-code");
    await act(async () => { releaseFirst!(); });
    await act(async () => {
      for (const release of releaseScreens.splice(0)) release();
      await Promise.all(heldResponses);
    });
    await waitFor(() => expect(releaseSecond).toBeTypeOf("function"));
    const heldBefore = heldResponses.length;
    await act(async () => { releaseSecond!(); });
    await waitFor(() => expect(heldResponses.length).toBeGreaterThan(heldBefore));
    const finalRefresh = heldResponses[heldResponses.length - 1]!;
    await act(async () => {
      for (const release of releaseScreens.splice(0)) release();
      await finalRefresh;
      await Promise.all(heldResponses);
    });
    expect(releaseScreens).toHaveLength(0);
    await waitFor(async () => {
      const current = await originalCall("get_screen", { projectId }) as { values: Record<string, unknown> };
      expect(current.values).toMatchObject({ "writer.fallback1.provider": "claude-code", "writer.fallback1.model": "claude-opus-5" });
    });
    expect(fallbackSaveCalls.map((call) => call.providerId)).toEqual(["qwen", "claude-code"]);
    expect(fallbackSaveCalls[1]!.expectedVersions).toEqual({ "writer.fallback1.provider": 1, "writer.fallback1.model": 1, "writer.fallback1.reasoning_effort": 1 });
    expect(slot.queryByTestId("cas-conflict")).toBeNull();
    expect(screenCalls.length).toBeGreaterThan(screensBefore);
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
