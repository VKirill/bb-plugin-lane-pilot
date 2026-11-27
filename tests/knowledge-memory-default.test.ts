/** @vitest-environment jsdom */
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { en } from "@lane-pilot/i18n";
import { parseMemorySettings } from "@lane-pilot/memory-core";
import { SettingsScreen } from "../src/rooms/pages/ui/screens/settings-screen";

afterEach(() => cleanup());

// The «Знания → Память» switch showed «Выкл» on unset projects while the server ran memory on (owner, 2026-11-08).
describe("settings memory default state", () => {
  it("shows the server default when the setting is unset", () => {
    const page = {
      projectId: null,
      isGlobal: true,
      selectedSectionId: null,
      selectedProjectName: null,
      selectedSectionName: null,
      projects: [],
      sections: [],
      level: "system" as const,
      localePreference: "en" as const,
      chooseLocale: async () => undefined,
      extrasGrouped: [],
      stackControls: false,
      catalogRow: () => undefined,
      displayedValue: () => undefined,
      applySetting: async () => undefined,
      writeDraft: () => undefined,
    } as never;
    const slot = renderSlot(
      { id: "settings-memory-test", component: () => createElement(SettingsScreen, { page }) } as never,
      {} as never,
      { rpc: { owner_waiting_config: () => null } },
    );
    fireEvent.click(slot.getByTestId("settings-nav-memory"));
    const memorySection = slot.getByTestId("memory-knowledge");
    const expectedLabel = parseMemorySettings({}).enabled ? en.on : en.off;
    expect(memorySection.textContent).toContain(expectedLabel);
    slot.lifecycle.unmount();
  });
});
