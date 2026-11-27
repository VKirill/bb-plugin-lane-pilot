/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import { boardFixture, cardFixture, screenFixture } from "./ui-harness";

vi.setConfig({ testTimeout: 60_000 });
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
configure({ asyncUtilTimeout: 10_000 });

const PROJECTS = [
  { id: "proj_alpha", name: "Alpha shop" },
  { id: "proj_beta", name: "Beta blog" },
];

const AGENTS = [
  {
    id: "growth-marketer",
    description: "Growth marketer",
    displayName: "Growth marketer",
    kind: "specialist",
    custom: false,
    domain: "marketing",
    prompt: "Marketing prompt",
    sourceHash: "a".repeat(64),
    sourceVersion: "bb-session-1",
    edited: false,
  },
  {
    id: "copy-lead",
    description: "Copywriter",
    displayName: "Copywriter",
    kind: "specialist",
    custom: false,
    domain: "copy",
    prompt: "Copy prompt",
    sourceHash: "b".repeat(64),
    sourceVersion: "bb-session-1",
    edited: false,
  },
];

function defaultRpc(overrides: Record<string, (input: unknown) => unknown> = {}) {
  const baseScreen = screenFixture();
  return {
    get_preferences: () => ({
      locale: "ru" as const,
      preference: "ru" as const,
      lastProjectId: null,
    }),
    set_locale: () => ({ locale: "ru", preference: "ru" }),
    remember_project: () => ({ ok: true }),
    list_projects: () => ({ projects: PROJECTS, lastProjectId: null }),
    list_sections: () => ({ sections: [] }),
    get_routing_hint: () => ({ current: null, stats: [] }),
    get_screen: (input: unknown) => ({
      ...baseScreen,
      projectId: (input as { projectId?: string }).projectId ?? "proj_alpha",
    }),
    task_board: () => boardFixture(),
    task_card: () => cardFixture(),
    work_graph_strips: () => ({}),
    owner_waiting: () => ({
      generatedAt: 1_800_000_000_000,
      now: 0,
      counts: {},
      overnight: { windowMs: 86_400_000, red: [], accepted: 0, rulesAdopted: 0, rulesConfirmed: 0 },
      answered: { owner: 0, agent: 0, lead: 0, janitor: 0 },
      items: [],
    }),
    list_agents: () => ({ agents: AGENTS }),
    specialist_overview: (input: unknown) => {
      const { projectId } = (input ?? {}) as { projectId?: string };
      if (projectId === "proj_alpha") {
        return {
          charters: [
            {
              projectId: "proj_alpha",
              domain: "marketing",
              version: 2,
              approvedBy: "owner",
              updatedAt: Date.now() - 10 * 86_400_000,
              metric: "paid_orders",
              current: 412,
              target: 600,
              due: "2027-03-01",
              onTrack: true,
              budgetUsedUsd: 31.4,
              budgetCapUsd: 45,
              autonomy: [
                { actionClass: "bid_adjust", level: "bounded_auto" },
                { actionClass: "new_campaign", level: "propose" },
              ],
              latestThreadId: "thr_sp_mkt_1",
            },
          ],
          breakers: [],
          pendingIntents: 0,
          dispatchedCount: 2,
          activeLocks: 0,
          openQuestionsCount: 0,
          artifactsCount: 1,
          taskTransitionsCount: 0,
          memoryReceiptsCount: 0,
          spend24hUsd: 4.2,
          spend30dUsd: 31.4,
        };
      }
      return {
        charters: [],
        breakers: [],
        pendingIntents: 0,
        dispatchedCount: 0,
        activeLocks: 0,
        openQuestionsCount: 0,
        artifactsCount: 0,
        taskTransitionsCount: 0,
        memoryReceiptsCount: 0,
        spend24hUsd: 0,
        spend30dUsd: 0,
      };
    },
    ...overrides,
  };
}

async function mountStaff({
  subPath = "staff",
  projectId = null,
  rpc = {},
}: {
  subPath?: string;
  projectId?: string | null;
  rpc?: Record<string, (input: unknown) => unknown>;
} = {}) {
  const app = await loadPluginApp(() => import("../app"));
  return renderSlot(app.navPanels[0]!, { subPath }, {
    context: { projectId, threadId: null },
    providers: { status: "ready", providers: [] } as never,
    rpc: defaultRpc(rpc),
  });
}

describe("console staff list (P3)", () => {
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

  it("splits chartered marketer and copy-lead via filter, routes to staff/<p>/marketing and staff/hire, opens chat when present, and unmounts SpecialistStatusCard", async () => {
    const overviewCalls: string[] = [];
    const slot = await mountStaff({
      rpc: {
        specialist_overview: (input) => {
          const { projectId } = (input ?? {}) as { projectId?: string };
          if (projectId) overviewCalls.push(projectId);
          return defaultRpc().specialist_overview(input);
        },
      },
    });

    await slot.findByTestId("console-staff");
    await slot.findByTestId("staff-card-proj_alpha:marketing");
    await slot.findByTestId("staff-card-agent:copy-lead");

    // SpecialistStatusCard must no longer be mounted in the console.
    expect(slot.queryByTestId("specialist-overview")).toBeNull();

    // Parallel specialist_overview calls ran for both projects in scope.
    expect([...new Set(overviewCalls)].sort()).toEqual(["proj_alpha", "proj_beta"]);

    // Chartered marketer card fields.
    expect(slot.getByTestId("staff-card-role-proj_alpha:marketing").textContent).toContain("Маркетолог роста");
    expect(slot.getByTestId("staff-card-project-proj_alpha:marketing").textContent).toContain("Alpha shop");
    expect(slot.getByTestId("staff-card-goal-proj_alpha:marketing").textContent).toContain("paid_orders");
    expect(slot.getByTestId("staff-card-goal-proj_alpha:marketing").textContent).toContain("412");
    expect(slot.getByTestId("staff-card-goal-proj_alpha:marketing").textContent).toContain("600");
    expect(slot.getByTestId("staff-card-goal-proj_alpha:marketing").textContent).toContain("2027-03-01");
    expect(slot.getByTestId("staff-card-status-proj_alpha:marketing").textContent).toContain("В графике");
    expect(slot.getByTestId("staff-card-budget-proj_alpha:marketing").textContent).toMatch(/\$31[.,]40/);
    expect(slot.getByTestId("staff-card-budget-proj_alpha:marketing").textContent).toMatch(/\$45[.,]00/);
    expect(slot.getByTestId("staff-card-autonomy-proj_alpha:marketing").textContent).toContain("Сам 1");

    // Chat button present on marketer (has latestThreadId) and hidden on copy-lead (no thread).
    expect(slot.queryByTestId("staff-chat-proj_alpha:marketing")).not.toBeNull();
    expect(slot.queryByTestId("staff-chat-agent:copy-lead")).toBeNull();

    // Filter «На ставке / По заданию» splits chartered vs task-based roles.
    fireEvent.click(slot.getByTestId("seg-staff-filter-chartered"));
    expect(slot.queryByTestId("staff-card-proj_alpha:marketing")).not.toBeNull();
    expect(slot.queryByTestId("staff-card-agent:copy-lead")).toBeNull();

    fireEvent.click(slot.getByTestId("seg-staff-filter-task"));
    expect(slot.queryByTestId("staff-card-proj_alpha:marketing")).toBeNull();
    expect(slot.queryByTestId("staff-card-agent:copy-lead")).not.toBeNull();

    fireEvent.click(slot.getByTestId("seg-staff-filter-all"));
    expect(slot.queryByTestId("staff-card-proj_alpha:marketing")).not.toBeNull();
    expect(slot.queryByTestId("staff-card-agent:copy-lead")).not.toBeNull();

    // Clicking «Открыть чат» opens the specialist thread (falls back to toThread when openTab is absent).
    fireEvent.click(slot.getByTestId("staff-chat-proj_alpha:marketing"));
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "thr_sp_mkt_1",
    });

    // Clicking «Открыть» on marketer routes to staff/proj_alpha/marketing.
    fireEvent.click(slot.getByTestId("staff-open-proj_alpha:marketing"));
    await slot.findByTestId("staff-page-placeholder");
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "lane-pilot",
      options: { subPath: "staff/proj_alpha/marketing" },
    });

    // Navigating back and clicking «Нанять» routes to staff/hire.
    fireEvent.click(slot.getByTestId("console-nav-staff"));
    await slot.findByTestId("staff-hire-btn");
    fireEvent.click(slot.getByTestId("staff-hire-btn"));
    await slot.findByTestId("staff-hire-placeholder");
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "lane-pilot",
      options: { subPath: "staff/hire" },
    });

    slot.lifecycle.unmount();
  });

  it("renders an error card for a failing project while other projects still render", async () => {
    const slot = await mountStaff({
      rpc: {
        specialist_overview: (input) => {
          const { projectId } = (input ?? {}) as { projectId?: string };
          if (projectId === "proj_beta") {
            throw new Error("beta overview unavailable");
          }
          return defaultRpc().specialist_overview(input);
        },
      },
    });

    await slot.findByTestId("staff-card-proj_alpha:marketing");
    const errCard = await slot.findByTestId("staff-project-error-proj_beta");
    expect(errCard.textContent).toContain("Beta blog");
    expect(errCard.textContent).toContain("beta overview unavailable");

    slot.lifecycle.unmount();
  });
});
