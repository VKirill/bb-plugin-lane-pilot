/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import type { ReviewDeskItem, ReviewDeskView } from "../src/rooms/contracts/ui";
import { ReviewDesk } from "../src/rooms/reports/ui";
import { shiftIsoWeek } from "../src/rooms/reports";

const toast = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.setConfig({ testTimeout: 60_000 });
configure({ asyncUtilTimeout: 10_000 });

const DEFAULT_AT = Date.parse("2026-11-30T07:00:00Z");
const CURRENT_WEEK = "2026-W48";
const PREV_WEEK = shiftIsoWeek(CURRENT_WEEK, -1);

function deskFixture(overrides: Partial<ReviewDeskView> = {}): ReviewDeskView {
  return {
    week: CURRENT_WEEK,
    items: [
      {
        id: "evolve:hyp_1",
        section: "evolve",
        question: "seo-research.verify (plus-2, gain=+10)",
        evidence: "hypothesis:hyp_1",
        options: [
          { id: "approve", label: "Повысить", isDefault: true },
          { id: "reject", label: "Оставить прежнюю", isDefault: false },
        ],
        answered: null,
        defaultAt: DEFAULT_AT,
      },
      {
        id: "deferred:task-word:run_1:t1:att_1",
        section: "deferred",
        question: "Слить задачу Add billing guard?",
        evidence: "task-word:run_1:t1:att_1",
        options: [
          { id: "yes", label: "Да, сливать", isDefault: false },
          { id: "keep", label: "Оставить", isDefault: true },
        ],
        answered: null,
        defaultAt: DEFAULT_AT,
      },
    ],
    ...overrides,
  };
}

function archivedPrevWeekFixture(): ReviewDeskView {
  const items: ReviewDeskItem[] = [
    {
      id: "road:road_prev_1",
      section: "candidates",
      question: "process: Weekly SEO digest",
      evidence: "cand:seo-digest",
      options: [
        { id: "save as draft", label: "save as draft", isDefault: false },
        { id: "later", label: "later", isDefault: true },
      ],
      answered: "later",
      defaultAt: DEFAULT_AT - 7 * 86_400_000,
    },
  ];
  return { week: PREV_WEEK, items };
}

function defaultProviders() {
  return {
    status: "ready",
    providers: [{
      id: "codex",
      displayName: "Codex",
      available: true,
      capabilities: {
        modelCatalogScope: "host",
        permissionModes: [],
        supportsFork: false,
        supportsNativeUserQuestion: false,
        supportsServiceTier: true,
        supportsSessionRewind: false,
        supportsThreadArchive: false,
        supportsThreadRename: false,
      },
      serviceTiers: [{ id: "default", label: "Default" }],
    }],
  } as never;
}

describe("Decisions screen — weekly desk tab (P2)", () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
    setLocaleOverride("ru");
    toast.success.mockClear();
    toast.error.mockClear();
  });

  afterEach(() => {
    cleanup();
    setLocaleOverride(null);
    document.documentElement.lang = "en";
    vi.restoreAllMocks();
  });

  it("renders sections, questions, evidence link, default radio mark, answers an item via desk_answer, and confirms desk_accept_defaults", async () => {
    let currentItems = deskFixture().items;
    const deskGetRpc = vi.fn(() => ({ week: CURRENT_WEEK, items: currentItems }));
    const deskAnswerRpc = vi.fn((input: unknown) => {
      const { itemId, option } = input as { itemId: string; option: string };
      const target = currentItems.find((item) => item.id === itemId);
      if (!target) return { ok: false, reason: "item_not_found" };
      const updated: ReviewDeskItem = { ...target, answered: option };
      currentItems = currentItems.map((item) => (item.id === itemId ? updated : item));
      return { ok: true, item: updated };
    });
    const acceptDefaultsRpc = vi.fn((input: unknown) => {
      const { week } = input as { week: string };
      currentItems = currentItems.map((item) => {
        if (item.answered !== null) return item;
        const def = item.options.find((o) => o.isDefault)?.id ?? item.options[0]!.id;
        return { ...item, answered: def };
      });
      return { ok: true, accepted: 1, week };
    });

    const slot = renderSlot(
      { component: () => <ReviewDesk locale="ru" /> },
      {},
      {
        context: { projectId: null, threadId: null },
        rpc: {
          desk_get: deskGetRpc,
          desk_answer: deskAnswerRpc,
          desk_accept_defaults: acceptDefaultsRpc,
        },
      },
    );

    await slot.findByTestId("review-desk");
    await slot.findByTestId("desk-section-evolve");
    await slot.findByTestId("desk-section-deferred");

    expect(slot.getByTestId("desk-question-evolve:hyp_1").textContent).toContain("seo-research.verify");
    expect(slot.getByTestId("desk-evidence-evolve:hyp_1").textContent).toContain("hypothesis:hyp_1");
    expect(slot.getByTestId("desk-default-mark-evolve:hyp_1-approve").textContent).toContain("по умолчанию, если не ответите до");

    // Clicking evidence link navigates to graphs for hypothesis/draft or task route for task-word.
    fireEvent.click(slot.getByTestId("desk-evidence-evolve:hyp_1"));
    expect(slot.inspection.navigateCalls.some((call) =>
      call.method === "toPluginPanel" && (call as { options?: { subPath?: string } }).options?.subPath === "system/graphs")).toBe(true);

    // Answer one item -> calls desk_answer and marks item as answered.
    const rejectRadio = slot.getByTestId("desk-radio-evolve:hyp_1-reject") as HTMLInputElement;
    fireEvent.click(rejectRadio);

    await waitFor(() => expect(deskAnswerRpc).toHaveBeenCalledWith({
      itemId: "evolve:hyp_1",
      option: "reject",
    }));
    await waitFor(() => {
      expect(slot.getByTestId("desk-answered-evolve:hyp_1").textContent).toContain("Отвечено: reject");
      expect((slot.getByTestId("desk-radio-evolve:hyp_1-reject") as HTMLInputElement).checked).toBe(true);
    });

    // Click footer "Принять все варианты по умолчанию" -> opens ConfirmDialog first, then calls desk_accept_defaults.
    const acceptBtn = slot.getByTestId("desk-accept-defaults");
    expect(acceptBtn.textContent).toBe("Принять все варианты по умолчанию");
    fireEvent.click(acceptBtn);

    await waitFor(() => expect(slot.container.ownerDocument.querySelector("[role='alertdialog']")).not.toBeNull());
    expect(acceptDefaultsRpc).not.toHaveBeenCalled();

    const confirmBtn = Array.from(slot.container.ownerDocument.querySelectorAll("[role='alertdialog'] button"))
      .find((btn) => btn.textContent === "Принять по умолчанию");
    expect(confirmBtn).toBeTruthy();
    fireEvent.click(confirmBtn!);

    await waitFor(() => expect(acceptDefaultsRpc).toHaveBeenCalledWith({ week: CURRENT_WEEK }));
    await waitFor(() => {
      expect(slot.getByTestId("desk-answered-deferred:task-word:run_1:t1:att_1").textContent).toContain("Отвечено: keep");
    });

    slot.lifecycle.unmount();
  });

  it("switches to a previous week and renders all-answered previous weeks as read-only", async () => {
    const deskGetRpc = vi.fn((input: unknown) => {
      const req = (input ?? {}) as { week?: string };
      if (req.week === PREV_WEEK) return archivedPrevWeekFixture();
      return deskFixture();
    });
    const deskAnswerRpc = vi.fn();

    const slot = renderSlot(
      { component: () => <ReviewDesk locale="ru" /> },
      {},
      {
        context: { projectId: null, threadId: null },
        rpc: {
          desk_get: deskGetRpc,
          desk_answer: deskAnswerRpc,
        },
      },
    );

    await slot.findByTestId("desk-item-evolve:hyp_1");
    expect((slot.getByTestId("desk-next-week") as HTMLButtonElement).disabled).toBe(true);
    expect(slot.queryByTestId("desk-readonly-badge")).toBeNull();

    // Navigate to previous week.
    fireEvent.click(slot.getByTestId("desk-prev-week"));
    await waitFor(() => expect(deskGetRpc).toHaveBeenCalledWith({ week: PREV_WEEK }));
    await slot.findByTestId("desk-item-road:road_prev_1");

    expect(slot.getByTestId("desk-readonly-badge").textContent).toContain("Только чтение");
    expect((slot.getByTestId("desk-radio-road:road_prev_1-save as draft") as HTMLInputElement).disabled).toBe(true);
    expect((slot.getByTestId("desk-accept-defaults") as HTMLButtonElement).disabled).toBe(true);
    expect((slot.getByTestId("desk-next-week") as HTMLButtonElement).disabled).toBe(false);
    expect(deskAnswerRpc).not.toHaveBeenCalled();

    // Return to current week.
    fireEvent.click(slot.getByTestId("desk-current-week"));
    await slot.findByTestId("desk-item-evolve:hyp_1");
    expect(slot.queryByTestId("desk-readonly-badge")).toBeNull();

    slot.lifecycle.unmount();
  });

  it("mounts ReviewDesk inside DecisionsScreen from route decisions/desk/<week> and syncs week switcher with route", async () => {
    const deskGetRpc = vi.fn((input: unknown) => {
      const req = (input ?? {}) as { week?: string };
      if (req.week === PREV_WEEK) return archivedPrevWeekFixture();
      return deskFixture();
    });

    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: `decisions/desk/${PREV_WEEK}` }, {
      context: { projectId: null, threadId: null },
      providers: defaultProviders(),
      rpc: {
        get_preferences: () => ({ locale: "ru", preference: "ru", lastProjectId: null }),
        list_projects: () => ({ projects: [{ id: "proj_ui", name: "UI test" }], lastProjectId: null }),
        list_sections: () => ({ sections: [] }),
        owner_waiting: () => ({
          generatedAt: Date.now(),
          now: 0,
          counts: {},
          overnight: { windowMs: 86_400_000, red: [], accepted: 0, rulesAdopted: 0, rulesConfirmed: 0 },
          answered: { owner: 0, agent: 0, lead: 0, janitor: 0 },
          items: [],
        }),
        desk_get: deskGetRpc,
      } as never,
    });

    await slot.findByTestId("console-decisions");
    await slot.findByTestId("review-desk");
    await slot.findByTestId("desk-item-road:road_prev_1");
    expect(deskGetRpc).toHaveBeenCalledWith({ week: PREV_WEEK });

    fireEvent.click(slot.getByTestId("desk-prev-week"));
    const twoWeeksAgo = shiftIsoWeek(PREV_WEEK, -1);
    await waitFor(() => expect(
      slot.inspection.navigateCalls.some((call) =>
        call.method === "toPluginPanel" &&
        (call as { options?: { subPath?: string } }).options?.subPath === `decisions/desk/${twoWeeksAgo}`),
    ).toBe(true));

    slot.lifecycle.unmount();
  });
});
