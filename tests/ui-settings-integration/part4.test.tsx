/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { en, setLocaleOverride } from "@lane-pilot/i18n";
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
    const { harness, slot, nightSaveCalls, screenCalls } = await mountWithBackend({
      delayRpc: async (method, input) => {
        if (method === "save_night_review_selection" && (input as { providerId: string }).providerId === "qwen") await new Promise<void>((resolve) => { releaseFirst = resolve; });
      },
    });
    const picker = () => slot.getByTestId("night-review-settings").querySelector("[data-testid='bb-provider-model-picker']") as PickerNode;
    await waitFor(() => expect(picker().getAttribute("data-provider")).toBe("codex"));
    const screensBefore = screenCalls.length;
    await choosePickerValue({ providerId: "qwen", model: "qwen-test", reasoningLevel: "medium", serviceTier: "default" }, picker());
    await waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
    await choosePickerValue({ providerId: "claude-code", model: "claude-opus-5", reasoningLevel: "medium" }, picker());
    releaseFirst!();
    await waitFor(async () => {
      const current = await harness.behavior.callRpc("get_screen", { projectId }) as { values: Record<string, unknown> };
      expect(current.values).toMatchObject({ "night_review.provider": "claude-code", "night_review.model": "claude-opus-5" });
    });
    expect(nightSaveCalls).toHaveLength(2);
    expect(nightSaveCalls[1]!.expectedVersions).toEqual({ "night_review.provider": 1, "night_review.model": 1, "night_review.reasoning_effort": 1, "night_review.service_tier": 1 });
    expect(slot.queryByTestId("cas-conflict")).toBeNull();
    expect(screenCalls).toHaveLength(screensBefore);
    expect(picker().getAttribute("data-provider")).toBe("claude-code");
    // The role now has its own pair: the row says so and «Вернуть унаследованное» is live without a reload.
    expect(slot.getByTestId("role-origin-night_reviewer").textContent).toBe(en.accessOrigin_project);
    await finish(harness, slot);
  });

  it("shows the latest choice of a role picker at once, before any save has answered", async () => {
    let releaseFirst: (() => void) | undefined;
    const { harness, slot } = await mountWithBackend({
      delayRpc: async (method) => { if (method === "save_night_review_selection") await new Promise<void>((resolve) => { releaseFirst = resolve; }); },
    });
    const picker = () => slot.getByTestId("night-review-settings").querySelector("[data-testid='bb-provider-model-picker']") as PickerNode;
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
    const { harness, slot, fallbackSaveCalls, screenCalls } = await mountWithBackend({
      delayRpc: async (method, input) => {
        if (method === "save_writer_fallback_selection" && (input as { providerId?: string }).providerId === "qwen") await new Promise<void>((resolve) => { releaseFirst = resolve; });
      },
    });
    fireEvent.click(slot.getByTestId("role-open-writer"));
    const picker = () => scopedPicker(slot, "writer-fallback-1");
    await waitFor(() => expect(picker()).toBeTruthy());
    const screensBefore = screenCalls.length;
    fireEvent.pointerDown(picker());
    await choosePickerValue({ providerId: "qwen", model: "qwen-test", reasoningLevel: "medium" }, picker());
    await waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
    await choosePickerValue({ providerId: "claude-code", model: "claude-opus-5", reasoningLevel: "medium" }, picker());
    expect(picker().getAttribute("data-provider")).toBe("claude-code");
    releaseFirst!();
    await waitFor(async () => {
      const current = await harness.behavior.callRpc("get_screen", { projectId }) as { values: Record<string, unknown> };
      expect(current.values).toMatchObject({ "writer.fallback1.provider": "claude-code", "writer.fallback1.model": "claude-opus-5" });
    });
    expect(fallbackSaveCalls.map((call) => call.providerId)).toEqual(["qwen", "claude-code"]);
    expect(fallbackSaveCalls[1]!.expectedVersions).toEqual({ "writer.fallback1.provider": 1, "writer.fallback1.model": 1, "writer.fallback1.reasoning_effort": 1 });
    expect(slot.queryByTestId("cas-conflict")).toBeNull();
    expect(screenCalls).toHaveLength(screensBefore);
    await finish(harness, slot);
  });
});
