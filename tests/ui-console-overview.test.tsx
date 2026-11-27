/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import { OverviewScreen } from "../src/rooms/pages/ui/screens/overview-screen";
import type { ConsoleOverviewOutput } from "../src/rooms/contracts/ui";
import { screenFixture } from "./ui-harness";

vi.setConfig({ testTimeout: 60_000 });
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
configure({ asyncUtilTimeout: 10_000 });

const NOW = 1_800_000_000_000;

function overviewFixture(overrides: Partial<ConsoleOverviewOutput> = {}): ConsoleOverviewOutput {
  return {
    tz: "Europe/Moscow",
    counts: {
      active: 2,
      waiting: 3,
      closedToday: 4,
      spendTodayUsd: 1.25,
      goalsOnTrack: 1,
      goalsTotal: 1,
    },
    active: [
      {
        kind: "task",
        key: "task:run-1:task-1",
        title: "Фильтр заказов в админке",
        projectId: "proj_ui",
        stage: "code-critique",
        since: NOW - 24 * 60_000,
        costUsd: 0.42,
        runId: "run-1",
        taskId: "task-1",
      },
      {
        kind: "batch",
        key: "batch:draft-9",
        title: "Пачка из 3 задач",
        projectId: "proj_alpha",
        stage: null,
        since: NOW - 10 * 60_000,
        costUsd: null,
        runId: "thr_pm_batch",
        taskId: null,
      },
    ],
    closedByDay: [
      { day: "2026-11-25", accepted: 2, reworked: 1, canceled: 0, failed: 0 },
      { day: "2026-11-26", accepted: 3, reworked: 0, canceled: 1, failed: 0 },
      { day: "2026-11-27", accepted: 2, reworked: 1, canceled: 0, failed: 1 },
    ],
    goals: [
      {
        projectId: "proj_ui",
        domain: "growth-marketer",
        metric: "paid_orders",
        current: 412,
        target: 600,
        due: "2026-03-01",
        onTrack: true,
      },
    ],
    costCoverage: 0.75,
    ...overrides,
  };
}

describe("OverviewScreen", () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
    setLocaleOverride("ru");
  });

  afterEach(() => {
    cleanup();
    setLocaleOverride(null);
    document.documentElement.lang = "en";
  });

  it("renders tiles, active table, 3-day chart, goal, upcoming runs, costCoverage note, and routes on clicks", async () => {
    const go = vi.fn();
    const overviewCalls: unknown[] = [];

    const slot = renderSlot(
      {
        component: () => (
          <OverviewScreen
            projectId={null}
            sectionId={null}
            go={go}
            projects={[
              { id: "proj_ui", name: "UI test" },
              { id: "proj_alpha", name: "Alpha app" },
            ]}
            locale="ru"
          />
        ),
      },
      {},
      {
        context: { projectId: null, threadId: null },
        rpc: {
          console_overview: (input: unknown) => {
            overviewCalls.push(input);
            return overviewFixture();
          },
          schedule_calendar: () => ({
            planned: [
              { scheduleId: "sched-pulse", at: NOW + 3_600_000 },
              { scheduleId: "sched-nightly", at: NOW + 7_200_000 },
            ],
            past: [],
            truncated: [],
          }),
        },
      },
    );

    await slot.findByTestId("overview-kpis");
    expect(overviewCalls[0]).toEqual({ days: 7 });

    expect(slot.getByTestId("kpi-active").textContent).toContain("2");
    expect(slot.getByTestId("kpi-waiting").textContent).toContain("3");
    expect(slot.getByTestId("kpi-closed-today").textContent).toContain("4");
    expect(slot.getByTestId("kpi-spend-today").textContent).toContain("$");
    expect(slot.getByTestId("kpi-spend-today").textContent).toContain("цена известна для 75%");
    expect(slot.getByTestId("kpi-goals").textContent).toContain("1 из 1");

    // 2 active items rendered in the table.
    const taskRow = slot.getByTestId("overview-active-row-task:run-1:task-1");
    expect(taskRow.textContent).toContain("Фильтр заказов в админке");
    expect(taskRow.textContent).toContain("UI test");

    const batchRow = slot.getByTestId("overview-active-row-batch:draft-9");
    expect(batchRow.textContent).toContain("Пачка из 3 задач");
    expect(batchRow.textContent).toContain("Alpha app");

    // 3 days of closed counts in the SVG chart.
    expect(slot.getByTestId("overview-chart-bar-2026-11-25").getAttribute("data-total")).toBe("3");
    expect(slot.getByTestId("overview-chart-bar-2026-11-26").getAttribute("data-total")).toBe("4");
    expect(slot.getByTestId("overview-chart-bar-2026-11-27").getAttribute("data-total")).toBe("4");

    // 1 goal and upcoming schedule runs.
    const goalRow = slot.getByTestId("overview-goal-proj_ui-growth-marketer");
    expect(goalRow.textContent).toContain("69%");
    expect(slot.getByTestId("overview-upcoming-list").textContent).toContain("sched-pulse");
    expect(slot.getByTestId("overview-upcoming-list").textContent).toContain("sched-nightly");

    // Clicking waiting tile routes to decisions.
    fireEvent.click(slot.getByTestId("kpi-waiting"));
    expect(go).toHaveBeenCalledWith({ section: "decisions" });

    // Clicking task row routes to work/task/<run>/<task>.
    fireEvent.click(taskRow);
    expect(go).toHaveBeenCalledWith({
      section: "work",
      taskRef: { runId: "run-1", taskId: "task-1" },
    });

    // Clicking batch row opens its PM thread via navigate.toThread.
    fireEvent.click(batchRow);
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr_pm_batch" });

    // Clicking goal row routes to staff/<projectId>/<domain>.
    fireEvent.click(goalRow);
    expect(go).toHaveBeenCalledWith({
      section: "staff",
      staffRef: { projectId: "proj_ui", domain: "growth-marketer" },
    });

    slot.lifecycle.unmount();
  });

  it("shows empty state with links to Staff/Work and inline retry on query error", async () => {
    const go = vi.fn();
    let shouldFail = true;

    const slot = renderSlot(
      {
        component: () => (
          <OverviewScreen projectId="proj_ui" sectionId={null} go={go} locale="ru" />
        ),
      },
      {},
      {
        context: { projectId: "proj_ui", threadId: null },
        rpc: {
          console_overview: () => {
            if (shouldFail) throw new Error("Hub offline");
            return overviewFixture({
              counts: { active: 0, waiting: 0, closedToday: 0, spendTodayUsd: null, goalsOnTrack: 0, goalsTotal: 0 },
              active: [],
              closedByDay: [],
              goals: [],
              costCoverage: 1,
            });
          },
          schedule_calendar: () => ({ planned: [], past: [], truncated: [] }),
        },
      },
    );

    const errorCard = await slot.findByTestId("overview-error");
    expect(errorCard.textContent).toContain("Hub offline");

    shouldFail = false;
    fireEvent.click(slot.getByTestId("overview-retry"));

    const emptyBlock = await slot.findByTestId("overview-active-empty");
    expect(emptyBlock.textContent).toContain("Сейчас ничего не идёт");
    expect(slot.getByTestId("kpi-spend-today").textContent).not.toContain("цена известна");

    fireEvent.click(slot.getByTestId("overview-empty-staff"));
    expect(go).toHaveBeenCalledWith({ projectId: "proj_ui", section: "staff" });

    fireEvent.click(slot.getByTestId("overview-empty-work"));
    expect(go).toHaveBeenCalledWith({ projectId: "proj_ui", section: "work" });

    slot.lifecycle.unmount();
  });

  it("mounts Overview as the default section in the plugin console", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        context: { projectId: null, threadId: null },
        rpc: {
          get_preferences: () => ({ locale: "ru", preference: "ru", lastProjectId: null }),
          list_projects: () => ({ projects: [{ id: "proj_ui", name: "UI test" }], lastProjectId: null }),
          list_sections: () => ({ sections: [] }),
          get_screen: () => screenFixture(),
          owner_waiting: () => ({ generatedAt: NOW, items: [], counts: {}, overnight: { windowMs: 1, red: [], accepted: 0, rulesAdopted: 0, rulesConfirmed: 0 }, now: 0, answered: { owner: 0, agent: 0, lead: 0, janitor: 0 } }),
          console_overview: () => overviewFixture(),
          schedule_calendar: () => ({ planned: [], past: [], truncated: [] }),
        },
      },
    );

    await slot.findByTestId("console-overview");
    await waitFor(() => expect(slot.getByTestId("kpi-active").textContent).toContain("2"));
    expect(slot.getByTestId("console-nav-overview").getAttribute("aria-current")).toBe("page");
    slot.lifecycle.unmount();
  });
});
