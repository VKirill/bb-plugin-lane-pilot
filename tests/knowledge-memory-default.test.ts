/** @vitest-environment jsdom */
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { en } from "@lane-pilot/i18n";
import { parseMemorySettings } from "@lane-pilot/memory-core";
import { KnowledgeTab } from "../src/rooms/pages/ui/tab-knowledge";

afterEach(() => cleanup());

// The «Знания → Память» switch showed «Выкл» on unset projects while the server ran memory on (owner, 2026-11-08).
describe("knowledge tab memory switch", () => {
  it("shows the server default when the setting is unset", () => {
    const page = {
      projectId: null,
      isGlobal: true,
      advanced: false,
      tabSelect: false,
      segmentOf: () => "memory",
      setSegment: () => undefined,
      displayedValue: () => undefined,
      catalogRow: () => undefined,
      applySetting: async () => undefined,
      writeDraft: () => undefined,
    } as never;
    const { getByTestId } = render(createElement(KnowledgeTab, { page }));
    const memorySection = getByTestId("memory-knowledge");
    const expectedLabel = parseMemorySettings({}).enabled ? en.on : en.off;
    expect(memorySection.textContent).toContain(expectedLabel);
  });
});
