/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { en, setLocaleOverride } from "@lane-pilot/i18n";
import { projectId, mountWithBackend, writerPicker, choosePickerValue, finish } from "./helpers";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

describe("native writer settings against the registered SQLite backend", () => {
  afterEach(() => {
    cleanup();
    setLocaleOverride(null);
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it("maps leftover low to catalog defaultReasoningEffort and keeps an explicit supported high", async () => {
    const { harness, slot } = await mountWithBackend();
    const before = await harness.behavior.callRpc("get_screen", { projectId }) as { versions:Record<string,number> };
    const versions = {
      "writer.provider":before.versions["writer.provider"] ?? 0,
      "writer.model":before.versions["writer.model"] ?? 0,
      "writer.reasoning_effort":before.versions["writer.reasoning_effort"],
      "writer.service_tier":before.versions["writer.service_tier"],
    };
    const leftoverLow = await harness.behavior.callRpc("save_writer_selection", {
      projectId, providerId:"acp-cursor", model:"grok-4.6", reasoningLevel:"low", serviceTier:"fast", expectedVersions:versions,
    }) as { ok:boolean; values:Record<string,unknown>; versions:Record<string,number> };
    expect(leftoverLow).toMatchObject({
      ok:true,
      values:{
        "writer.provider":"acp-cursor",
        "writer.model":"grok-4.6",
        "writer.reasoning_effort":"xhigh",
        "writer.service_tier":"standard",
      },
    });
    const explicitHigh = await harness.behavior.callRpc("save_writer_selection", {
      projectId, providerId:"acp-cursor", model:"grok-4.6", reasoningLevel:"high", serviceTier:null,
      expectedVersions:leftoverLow.versions,
    }) as { ok:boolean; values:Record<string,unknown> };
    expect(explicitHigh).toMatchObject({ ok:true, values:{ "writer.reasoning_effort":"high", "writer.model":"grok-4.6" } });
    const readback = await harness.behavior.callRpc("get_screen", { projectId }) as { values:Record<string,unknown> };
    expect(readback.values).toMatchObject({
      "writer.provider":"acp-cursor",
      "writer.model":"grok-4.6",
      "writer.reasoning_effort":"high",
      "writer.service_tier":"standard",
    });
    await finish(harness, slot);
  });

  it("keeps the last Cursor selection while an earlier writer save is still in flight", async () => {
    let releaseFirst: (() => void) | undefined;
    const { harness, slot, saveCalls } = await mountWithBackend({
      delayWriterSave: async (input) => {
        if (input.providerId === "codex" && input.reasoningLevel === "low") {
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
      },
    });
    await choosePickerValue({ providerId:"codex", model:"gpt-6-luna", reasoningLevel:"low", serviceTier:"default" });
    await waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
    await choosePickerValue({ providerId:"acp-cursor", model:"claude-opus-5", reasoningLevel:"low" });
    expect(writerPicker(slot).getAttribute("data-provider")).toBe("acp-cursor");
    expect(writerPicker(slot).getAttribute("data-model")).toBe("claude-opus-5");
    releaseFirst!();
    await waitFor(async () => {
      const current = await harness.behavior.callRpc("get_screen", { projectId }) as { values:Record<string,unknown> };
      expect(current.values).toMatchObject({
        "writer.provider":"acp-cursor",
        "writer.model":"claude-opus-5",
        "writer.reasoning_effort":"medium",
      });
    });
    expect(saveCalls.at(-1)).toMatchObject({ providerId:"acp-cursor", model:"claude-opus-5" });
    expect(writerPicker(slot).getAttribute("data-provider")).toBe("acp-cursor");
    expect(slot.queryByTestId("setting-validation-error")).toBeNull();
    await finish(harness, slot);
  });

  it("keeps the attempted picker draft and shows the RPC reason when the model is not in catalog", async () => {
    const { harness, slot } = await mountWithBackend();
    await choosePickerValue({ providerId:"acp-cursor", model:"not-in-catalog", reasoningLevel:"medium" });
    await waitFor(() => expect(slot.getByTestId("setting-validation-error")).toBeTruthy());
    fireEvent.click(slot.getByTestId("role-open-writer"));
    expect(slot.getByTestId("writer-save-error")).toBeTruthy();
    expect(writerPicker(slot).getAttribute("data-provider")).toBe("acp-cursor");
    expect(writerPicker(slot).getAttribute("data-model")).toBe("not-in-catalog");
    const persisted = await harness.behavior.callRpc("get_screen", { projectId }) as { values:Record<string,unknown> };
    expect(persisted.values["writer.provider"]).toBe("codex");
    expect(persisted.values["writer.model"]).toBe("gpt-6-luna");
    await finish(harness, slot);
  });

  it("does not reload away a Cursor draft when writer save hits a CAS conflict", async () => {
    const { harness, slot } = await mountWithBackend();
    const before = await harness.behavior.callRpc("get_screen", { projectId }) as { versions:Record<string,number> };
    const external = await harness.behavior.callRpc("save_writer_selection", {
      projectId, providerId:"codex", model:"gpt-6-luna", reasoningLevel:"xhigh", serviceTier:"fast",
      expectedVersions:{
        "writer.provider":before.versions["writer.provider"] ?? 0,
        "writer.model":before.versions["writer.model"] ?? 0,
        "writer.reasoning_effort":before.versions["writer.reasoning_effort"],
        "writer.service_tier":before.versions["writer.service_tier"],
      },
    }) as { ok:boolean };
    expect(external.ok).toBe(true);
    await choosePickerValue({ providerId:"acp-cursor", model:"claude-opus-5", reasoningLevel:"medium" });
    await waitFor(() => expect(slot.getByTestId("cas-conflict")).toBeTruthy());
    expect(writerPicker(slot).getAttribute("data-provider")).toBe("acp-cursor");
    expect(writerPicker(slot).getAttribute("data-model")).toBe("claude-opus-5");
    const persisted = await harness.behavior.callRpc("get_screen", { projectId }) as { values:Record<string,unknown> };
    expect(persisted.values).toMatchObject({ "writer.provider":"codex", "writer.model":"gpt-6-luna", "writer.reasoning_effort":"xhigh" });
    await finish(harness, slot);
  });
});
