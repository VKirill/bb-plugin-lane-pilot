/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { installTestPluginRuntime, loadPluginApp, renderSlot, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import React from "react";
import { VISIBLE_CATALOG } from "../src/ui-catalog";
import { en, setLocaleOverride } from "../i18n";
import plugin from "../server";
import { toast } from "sonner";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

let pickerValue: { providerId: string; model: string; reasoningLevel: string } | null = null;
let pickerOnChange: ((next: { providerId: string; model: string; reasoningLevel: string }) => void) | null = null;
let pickerCallbackCount = 0;

function installPickerTestDriver() {
  installTestPluginRuntime();
  const host = globalThis as typeof globalThis & { __bbPluginRuntime?: { pluginSdkApp: Record<string, unknown> } };
  const sdk = host.__bbPluginRuntime!.pluginSdkApp;
  host.__bbPluginRuntime!.pluginSdkApp = {
    ...sdk,
    experimental_ProviderModelPicker: (props: { value: { providerId: string; model: string; reasoningLevel: string }; onChange: (next: { providerId: string; model: string; reasoningLevel: string }) => void }) => React.createElement(
      "div",
      {
        "data-testid": "bb-provider-model-picker",
        "data-provider": props.value.providerId,
        "data-effort": props.value.reasoningLevel,
      },
      (pickerValue = props.value, pickerOnChange = (next) => { pickerCallbackCount += 1; props.onChange(next); }, null),
    ),
  };
}

const projectId = "proj_settings_integration";

type Screen = {
  values: Record<string, unknown>;
  versions: Record<string, number>;
};

type Change = { key: string; value: unknown; expectedVersion: number };

async function mountWithBackend(provider: string, effort: string) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  await plugin(bb);
  const seeded = await harness.behavior.callRpc("save_settings", {
    projectId,
    changes: [
      { key: "writer.provider", value: provider, expectedVersion: 0 },
      { key: "writer.reasoning_effort", value: effort, expectedVersion: 0 },
    ],
  }) as { ok: boolean };
  expect(seeded.ok).toBe(true);

  const saveCalls: Change[][] = [];
  installPickerTestDriver();
  const appModule = await import("../app");
  const app = await loadPluginApp(appModule);
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    context: { projectId, threadId: null },
    rpc: {
      get_preferences: (input) => harness.behavior.callRpc("get_preferences", input) as Promise<unknown>,
      set_locale: (input) => harness.behavior.callRpc("set_locale", input) as Promise<unknown>,
      remember_project: (input) => harness.behavior.callRpc("remember_project", input) as Promise<unknown>,
      get_screen: (input) => harness.behavior.callRpc("get_screen", input) as Promise<unknown>,
      save_settings: (input) => {
        const changes = (input as { changes: Change[] }).changes;
        saveCalls.push(changes);
        return harness.behavior.callRpc("save_settings", input) as Promise<unknown>;
      },
    },
  });
  await waitFor(() => {
    expect(slot.getByTestId("bb-provider-model-picker").getAttribute("data-provider")).toBe(provider);
    expect(slot.getByTestId("bb-provider-model-picker").getAttribute("data-effort")).toBe(effort);
  });
  return { harness, slot, saveCalls };
}

function rowField(slot: RenderedSlot, key: string) {
  const row = VISIBLE_CATALOG.find((item) => item.storageKey === key && item.uiStatus === "editable");
  if (!row) throw new Error(`missing editable row ${key}`);
  return slot.getByTestId(`field-${row.id}`);
}

async function selectRowValue(slot: RenderedSlot, key: string, value: string) {
  const control = rowField(slot, key).querySelector("[role='combobox']") as HTMLButtonElement;
  fireEvent.click(control);
  const option = await waitFor(() => {
    const found = Array.from(document.querySelectorAll("[role='option']"))
      .find((node) => node.textContent?.trim() === value);
    if (!found) throw new Error(`select option not found: ${value}`);
    return found;
  });
  fireEvent.click(option);
}

async function chooseProviderFromRow(slot: RenderedSlot, provider: string) {
  await selectRowValue(slot, "writer.provider", provider);
}

async function chooseProviderFromPicker(slot: RenderedSlot, provider: string) {
  slot.getByTestId("writer-picker");
  if (!pickerValue || !pickerOnChange) throw new Error("ProviderModelPicker test driver was not rendered");
  await act(async () => {
    pickerOnChange!({ ...pickerValue!, providerId: provider });
    await Promise.resolve();
  });
}

async function expectDisplayedPair(slot: RenderedSlot, screen: Screen, provider: string, effort: string) {
  expect(screen.values).toMatchObject({ "writer.provider": provider, "writer.reasoning_effort": effort });
  expect(rowField(slot, "writer.provider").querySelector("[role='combobox']")?.textContent).toContain(provider);
  expect(rowField(slot, "writer.reasoning_effort").querySelector("[role='combobox']")?.textContent).toContain(effort);
  const picker = slot.getByTestId("writer-picker");
  expect(picker.querySelector("[data-testid='bb-provider-model-picker']")?.getAttribute("data-provider")).toBe(provider);
  expect(picker.querySelector("[data-testid='bb-provider-model-picker']")?.getAttribute("data-effort")).toBe(effort);
}

async function finish(harness: Awaited<ReturnType<typeof createFakePluginHost>>["harness"], slot: RenderedSlot) {
  slot.lifecycle.unmount();
  await harness.lifecycle.dispose();
}

describe("provider/effort UI against the registered SQLite backend", () => {
  afterEach(() => {
    cleanup();
    pickerValue = null;
    pickerOnChange = null;
    pickerCallbackCount = 0;
    setLocaleOverride(null);
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it.each([
    ["catalog row", chooseProviderFromRow],
    ["ProviderModelPicker", chooseProviderFromPicker],
  ] as const)("normalizes codex/max → qwen/low through %s, then matches get_screen values and versions", async (_controlName, chooseProvider) => {
    const { harness, slot, saveCalls } = await mountWithBackend("codex", "max");
    const before = await harness.behavior.callRpc("get_screen", { projectId }) as Screen;

    await chooseProvider(slot, "qwen");
    if (_controlName === "ProviderModelPicker") expect(pickerCallbackCount).toBe(1);
    await waitFor(() => expect(saveCalls).toHaveLength(1));
    await waitFor(async () => {
      const current = await harness.behavior.callRpc("get_screen", { projectId }) as Screen;
      await expectDisplayedPair(slot, current, "qwen", "low");
    });
    const saved = await harness.behavior.callRpc("get_screen", { projectId }) as Screen;
    expect(saved.versions).toMatchObject({
      "writer.provider": before.versions["writer.provider"]! + 1,
      "writer.reasoning_effort": before.versions["writer.reasoning_effort"]! + 1,
    });
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0]!.filter(({ key }) => key === "writer.provider" || key === "writer.reasoning_effort")).toEqual([
      { key: "writer.provider", value: "qwen", expectedVersion: before.versions["writer.provider"]! },
      { key: "writer.reasoning_effort", value: "low", expectedVersion: before.versions["writer.reasoning_effort"]! },
    ]);
    expect(toast.info).toHaveBeenCalledWith(expect.objectContaining({ props: expect.objectContaining({ "data-bb-ru-skip": true, children: en.writerEffortAdjusted.replace("{from}", "max").replace("{to}", "low").replace("{provider}", "qwen") }) }));

    await selectRowValue(slot, "writer.reasoning_effort", "medium");
    await waitFor(async () => {
      const current = await harness.behavior.callRpc("get_screen", { projectId }) as Screen;
      await expectDisplayedPair(slot, current, "qwen", "medium");
    });
    expect(saveCalls[1]!.find(({ key }) => key === "writer.reasoning_effort")?.expectedVersion)
      .toBe(saved.versions["writer.reasoning_effort"]);
    await finish(harness, slot);
  });

  it.each([
    ["catalog row", chooseProviderFromRow],
    ["ProviderModelPicker", chooseProviderFromPicker],
  ] as const)("preserves qwen/medium → codex/medium through %s without an adjustment notice", async (_controlName, chooseProvider) => {
    const { harness, slot, saveCalls } = await mountWithBackend("qwen", "medium");
    const before = await harness.behavior.callRpc("get_screen", { projectId }) as Screen;

    await chooseProvider(slot, "codex");
    if (_controlName === "ProviderModelPicker") expect(pickerCallbackCount).toBe(1);
    await waitFor(() => expect(saveCalls).toHaveLength(1));
    await waitFor(async () => {
      const current = await harness.behavior.callRpc("get_screen", { projectId }) as Screen;
      await expectDisplayedPair(slot, current, "codex", "medium");
    });
    const saved = await harness.behavior.callRpc("get_screen", { projectId }) as Screen;
    expect(saved.versions).toMatchObject({
      "writer.provider": before.versions["writer.provider"]! + 1,
      "writer.reasoning_effort": before.versions["writer.reasoning_effort"]! + 1,
    });
    expect(saveCalls[0]!.filter(({ key }) => key === "writer.provider" || key === "writer.reasoning_effort")).toEqual([
      { key: "writer.provider", value: "codex", expectedVersion: before.versions["writer.provider"]! },
      { key: "writer.reasoning_effort", value: "medium", expectedVersion: before.versions["writer.reasoning_effort"]! },
    ]);
    expect(toast.info).not.toHaveBeenCalled();

    await selectRowValue(slot, "writer.reasoning_effort", "max");
    await waitFor(async () => {
      const current = await harness.behavior.callRpc("get_screen", { projectId }) as Screen;
      await expectDisplayedPair(slot, current, "codex", "max");
    });
    expect(saveCalls[1]!.find(({ key }) => key === "writer.reasoning_effort")?.expectedVersion)
      .toBe(saved.versions["writer.reasoning_effort"]);
    expect(toast.info).not.toHaveBeenCalled();
    await finish(harness, slot);
  });

  it("rerenders tab labels when the plugin locale changes in either direction", async () => {
    const { harness, slot } = await mountWithBackend("codex", "max");
    const labels = () => [
      slot.getByTestId("tab-settings").textContent,
      slot.getByTestId("tab-monitor").textContent,
      slot.getByTestId("tab-install").textContent,
    ];

    expect(slot.getByTestId("tab-settings").closest("[data-locale]")?.hasAttribute("data-bb-ru-skip")).toBe(true);
    expect(labels()).toEqual(["Settings", "Run Monitor", "Install"]);
    fireEvent.click(slot.getByRole("button", { name: "RU" }));
    await waitFor(() => expect(labels()).toEqual(["Настройки", "Монитор запусков", "Установка"]));
    fireEvent.click(slot.getByRole("button", { name: "EN" }));
    await waitFor(() => expect(labels()).toEqual(["Settings", "Run Monitor", "Install"]));
    fireEvent.click(slot.getByRole("button", { name: "Auto" }));
    await waitFor(() => expect(slot.getByRole("button", { name: "Auto" }).getAttribute("aria-pressed")).toBe("true"));
  });

  it("excludes the confirmation portal and plugin toast text from DOM translation", async () => {
    const { harness, slot } = await mountWithBackend("codex", "max");
    fireEvent.click(slot.getByTestId("tab-install"));
    fireEvent.click(slot.getByTestId("install-stack"));
    const dialog = await slot.findByTestId("external-ops-dialog");
    expect(dialog.hasAttribute("data-bb-ru-skip")).toBe(true);
    fireEvent.click(slot.getByRole("button", { name: en.confirmCancel }));
    await waitFor(() => expect(slot.queryByTestId("external-ops-dialog")).toBeNull());
    expect(toast.success).not.toHaveBeenCalledWith(expect.any(String));
    await finish(harness, slot);
  });

  it("rejects an invalid effort for a fixed provider without changing the UI or SQLite state", async () => {
    const { harness, slot, saveCalls } = await mountWithBackend("qwen", "medium");
    const before = await harness.behavior.callRpc("get_screen", { projectId }) as Screen;

    const invalid = await harness.behavior.callRpc("save_settings", {
      projectId,
      changes: [
        { key: "writer.reasoning_effort", value: "max", expectedVersion: before.versions["writer.reasoning_effort"] },
        { key: "writer.provider", value: "qwen", expectedVersion: before.versions["writer.provider"] },
      ],
    }) as { ok: boolean; conflict: boolean; validation?: { code: string } };
    expect(invalid).toMatchObject({ ok: false, conflict: false, validation: { code: "incompatible_setting" } });

    const after = await harness.behavior.callRpc("get_screen", { projectId }) as Screen;
    expect(after).toEqual(before);
    await expectDisplayedPair(slot, after, "qwen", "medium");
    expect(saveCalls).toHaveLength(0);
    await finish(harness, slot);
  });
});
