/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 30_000 });
beforeAll(() => { setLocaleOverride("en"); });
afterEach(() => { cleanup(); setLocaleOverride("en"); });

const NOW = 1_800_000_000_000;
const view = (extra: Record<string, unknown> = {}) => ({
  generatedAt: NOW,
  values: {},
  versions: {},
  status: {
    night: { enabled: true, hour: 3, lastRunAt: null, lastDryRun: false, lastSpend: null, lastCap: null, nextRunAt: null, openClasses: 0 },
    bench: null,
    policy: { version: 3, frozenAt: "2026-10-22T14:14:50Z", unseen: 0, needed: 20, enough: false, passed: false },
    waiting: { total: 0, wake: 0 },
  },
  policy: { version: 3, frozenAt: "2026-10-22T14:14:50Z", minAccuracy: 0.8, verdict: "x", accuracy: null, inSplit: 0, seenExcluded: 0, lastRun: null, tiers: [], prohibitions: [] },
  deferrals: { open: 0, overdue: 0, needsTerm: 0 },
  ...extra,
});

async function mount(rpc: Record<string, unknown>) {
  await loadPluginApp(() => import("../app"));
  const { ImprovementScreen } = await import("../src/rooms/improvement/ui");
  return renderSlot({ component: () => <ImprovementScreen locale="en" /> }, {}, { context: { projectId: null, threadId: null }, rpc: rpc as never });
}

describe("the «Судьи» section of the Self-improvement page", () => {
  it("renders each judge's plain name, labeled count, accuracy and fit", async () => {
    const slot = await mount({ improvement_view: () => view({ judges: [
      { id: "critique.screen", name: "Стоит ли показывать изменение коду-критику", labeled: 40, accuracy: 0.85, verdict: "gate" },
      { id: "route.workflow", name: "Какой граф подходит запросу", labeled: 7, accuracy: null, verdict: "sort-only" },
    ] }) });
    await slot.findByTestId("improvement-status");
    fireEvent.click(slot.getByTestId("seg-improvement-judges"));
    await slot.findByTestId("improvement-judges");
    const table = slot.getByTestId("judges-table");
    expect(table.textContent).toContain("Стоит ли показывать изменение коду-критику");
    expect(table.textContent).toContain("40");
    expect(table.textContent).toContain("85%");
    expect(table.textContent).toContain("может решать");
    expect(table.textContent).toContain("Какой граф подходит запросу");
    expect(table.textContent).toContain("только ранжирует");
  });

  it("says the night graph fills the labels when nothing is measured yet", async () => {
    const slot = await mount({ improvement_view: () => view({ judges: [] }) });
    await slot.findByTestId("improvement-status");
    fireEvent.click(slot.getByTestId("seg-improvement-judges"));
    await slot.findByTestId("improvement-judges");
    expect(slot.getByTestId("improvement-judges").textContent).toContain("ночной граф");
  });
});
