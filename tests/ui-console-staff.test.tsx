/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import { toast } from "sonner";
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
    specialist_detail: (input: unknown) => {
      const { projectId, domain } = (input ?? {}) as { projectId?: string; domain?: string };
      if (projectId === "proj_alpha" && domain === "marketing") {
        return {
          charter: {
            version: 3,
            approvedBy: "owner",
            approvedAt: 1_795_000_000_000,
            body: {
              goal: "600 оплативших заказов за 30 дней",
              north_star: {
                metric_id: "paid_orders_30d",
                formula: "SUM(orders.paid WHERE days <= 30)",
                source_of_truth: "CRM treba · orders",
                current: 412,
                target: 600,
                due: "2027-03-01",
              },
              guardrails: {
                max_cac: 600,
                min_romi: "120%",
                forbidden_topics: ["медицина", "гарантии"],
              },
              budgets: {
                monthly_cap_usd: 450,
                daily_cap_usd: 20,
                cell_cap_usd: 30,
              },
              channels: ["Яндекс Директ", "Telegram Ads"],
              latestThreadId: "thr_sp_mkt_1",
            },
            pendingDraft: {
              draftId: "draft_v4",
              body: { north_star: { target: 700 } },
            },
          },
          shifts: {
            last: {
              at: 1_800_000_000_000,
              depth: "daily_sweep",
              outcome: "succeeded",
              workflowId: "mkt-pulse-monitor",
              runId: "wf_shift_1",
            },
            next: {
              at: 1_800_014_400_000,
              depth: "heartbeat",
            },
            recent: [
              {
                at: 1_800_000_000_000,
                depth: "daily_sweep",
                outcome: "succeeded",
                workflowId: "mkt-pulse-monitor",
                runId: "wf_shift_1",
              },
            ],
          },
          northStar: {
            metric: "paid_orders_30d",
            series: [{ at: 1_799_900_000_000, value: 412 }],
            freshAt: 1_799_900_000_000,
          },
          caps: [
            { period: "day", capUsd: 20, usedUsd: 8.5 },
            { period: "month", capUsd: 450, usedUsd: 180 },
            { period: "test", capUsd: 30, usedUsd: 12 },
          ],
          autonomy: [
            {
              actionClass: "bid_adjust",
              level: "propose",
              sample: 34,
              confidence: 0.94,
              frozen: false,
            },
            {
              actionClass: "new_campaign",
              level: "observe",
              sample: 3,
              confidence: null,
              frozen: false,
            },
          ],
          loopHealth: { status: "ok", note: "10/10 conclusive (8w)" },
        };
      }
      return {
        charter: null,
        shifts: { last: null, next: null, recent: [] },
        northStar: null,
        caps: [],
        autonomy: [],
        loopHealth: null,
      };
    },
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
    expect(
      slot.getByTestId("seg-card-proj_alpha:marketing-bid_adjust-bounded_auto").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      slot.getByTestId("seg-card-proj_alpha:marketing-new_campaign-propose").getAttribute("aria-pressed"),
    ).toBe("true");

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
    await slot.findByTestId("staff-page");
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "lane-pilot",
      options: { subPath: "staff/proj_alpha/marketing" },
    });

    // The autonomy ladder on a card leads to the autonomy tab, where a change is confirmed.
    fireEvent.click(slot.getByTestId("console-nav-staff"));
    await slot.findByTestId("staff-hire-btn");
    fireEvent.click(slot.getByTestId("seg-card-proj_alpha:marketing-new_campaign-bounded_auto"));
    await slot.findByTestId("staff-tab-autonomy");
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "lane-pilot",
      options: { subPath: "staff/proj_alpha/marketing/autonomy" },
    });

    // Navigating back and clicking «Нанять» routes to staff/hire.
    fireEvent.click(slot.getByTestId("console-nav-staff"));
    await slot.findByTestId("staff-hire-btn");
    fireEvent.click(slot.getByTestId("staff-hire-btn"));
    await slot.findByTestId("staff-hire-wizard");
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

describe("console hire wizard (P3a)", () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
    setLocaleOverride("ru");
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  afterEach(() => {
    cleanup();
    setLocaleOverride(null);
    document.documentElement.lang = "en";
  });

  it("marketer path runs mkt-project-intake via workflow_run and routes to Decisions with toast", async () => {
    const workflowRunCalls: unknown[] = [];
    const sectionsCalls: unknown[] = [];
    const slot = await mountStaff({
      subPath: "staff/hire",
      rpc: {
        list_sections: (input) => {
          sectionsCalls.push(input);
          return {
            sections: [
              { id: "sec_web", parentId: null, name: "Web app", path: "apps/web", kind: "folder" },
            ],
          };
        },
        workflow_run: (input) => {
          workflowRunCalls.push(input);
          return { ok: true, runId: "wf_intake_1", created: true, status: "running" };
        },
      },
    });

    await slot.findByTestId("hire-step-role");
    expect(slot.queryByTestId("hire-role-growth-marketer")).not.toBeNull();
    expect(slot.queryByTestId("hire-role-copy-lead")).not.toBeNull();

    // Select marketer and advance to step 2 (project & section).
    fireEvent.click(slot.getByTestId("hire-role-growth-marketer"));
    fireEvent.click(slot.getByTestId("hire-next-project"));
    await slot.findByTestId("hire-step-project");
    await waitFor(() => {
      expect(sectionsCalls).toContainEqual({ projectId: "proj_alpha" });
    });

    // Advance to step 3 and start onboarding.
    fireEvent.click(slot.getByTestId("hire-next-start"));
    await slot.findByTestId("hire-step-intake");
    fireEvent.click(slot.getByTestId("hire-start-intake"));

    await waitFor(() => {
      expect(workflowRunCalls).toEqual([
        {
          id: "mkt-project-intake",
          projectId: "proj_alpha",
          inputs: {},
          source: "manual",
        },
      ]);
    });

    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      expect.stringContaining("вопросы придут сюда"),
    );
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "lane-pilot",
      options: { subPath: "decisions/waiting" },
    });
    await slot.findByTestId("console-decisions");

    slot.lifecycle.unmount();
  });

  it("shows missing requirements list when workflow_run preflight refuses", async () => {
    const slot = await mountStaff({
      subPath: "staff/hire",
      rpc: {
        workflow_run: () => ({
          ok: false,
          reason: "requirements_missing",
          message: "Missing requirements for onboarding",
          missing: ["project_url"],
          issues: [
            {
              kind: "secret",
              name: "YANDEX_DIRECT_TOKEN",
              level: "missing",
              message: "Secret YANDEX_DIRECT_TOKEN is not configured",
            },
          ],
          envRequests: [
            {
              name: "YANDEX_DIRECT_TOKEN",
              kind: "secret",
              purpose: "Read Yandex Direct campaigns",
            },
          ],
        }),
      },
    });

    await slot.findByTestId("hire-step-role");
    fireEvent.click(slot.getByTestId("hire-next-project"));
    await slot.findByTestId("hire-step-project");
    fireEvent.click(slot.getByTestId("hire-next-start"));
    await slot.findByTestId("hire-step-intake");

    fireEvent.click(slot.getByTestId("hire-start-intake"));
    const refused = await slot.findByTestId("hire-workflow-refused");
    const reqList = await slot.findByTestId("hire-refusal-requirements");
    expect(refused.textContent).toContain("Missing requirements for onboarding");
    expect(reqList.textContent).toContain("Secret YANDEX_DIRECT_TOKEN is not configured");
    expect(reqList.textContent).toContain("project_url");
    expect(reqList.textContent).toContain("YANDEX_DIRECT_TOKEN: Read Yandex Direct campaigns");

    slot.lifecycle.unmount();
  });

  it("copy-lead path opens ScheduleForm prefilled with kind agent, agentId copy-lead, and projectId", async () => {
    const previewCalls: unknown[] = [];
    const upsertCalls: unknown[] = [];
    const slot = await mountStaff({
      subPath: "staff/hire",
      rpc: {
        schedule_agents: () => ({
          agents: [
            { id: "copy-lead", displayName: "Копирайтер", description: "Copywriter" },
          ],
        }),
        schedule_list: () => ({
          schedules: [],
          hosts: [],
          now: 1_800_000_000_000,
          errandDefault: undefined,
        }),
        workflow_list: () => ({ workflows: [], problems: [], project: "ok" }),
        schedule_preview: (input) => {
          previewCalls.push(input);
          return {
            ok: true,
            problems: [],
            warnings: [],
            conflicts: [],
            nextFires: [1_800_003_600_000],
            timeoutSec: 600,
          };
        },
        schedule_upsert: (input) => {
          upsertCalls.push(input);
          return {
            ok: true,
            schedule: null,
            problems: [],
            warnings: [],
            conflicts: [],
          };
        },
      },
    });

    await slot.findByTestId("hire-step-role");
    fireEvent.click(slot.getByTestId("hire-role-copy-lead"));
    fireEvent.click(slot.getByTestId("hire-next-project"));
    await slot.findByTestId("hire-step-project");
    fireEvent.click(slot.getByTestId("hire-next-start"));

    await slot.findByTestId("hire-schedule-form-wrap");
    await slot.findByTestId("schedule-form");

    expect(slot.getByTestId("sch-kind-agent").getAttribute("aria-checked")).toBe("true");
    expect(slot.getByTestId("sch-agent").textContent).toContain("copy-lead");

    await waitFor(() => {
      expect(previewCalls.length).toBeGreaterThan(0);
    });
    const lastPreview = previewCalls[previewCalls.length - 1] as {
      definition: { projectId: string; task: { kind: string; agentId: string } };
    };
    expect(lastPreview.definition.projectId).toBe("proj_alpha");
    expect(lastPreview.definition.task.kind).toBe("agent");
    expect(lastPreview.definition.task.agentId).toBe("copy-lead");

    fireEvent.click(slot.getByTestId("sch-save"));
    await waitFor(() => {
      expect(upsertCalls).toHaveLength(1);
    });
    const savedDef = (upsertCalls[0] as {
      definition: { projectId: string; task: { kind: string; agentId: string } };
    }).definition;
    expect(savedDef.projectId).toBe("proj_alpha");
    expect(savedDef.task.kind).toBe("agent");
    expect(savedDef.task.agentId).toBe("copy-lead");

    await slot.findByTestId("console-staff");
    slot.lifecycle.unmount();
  });

  it("inline custom role form creates a role via save_agent_profile and selects it", async () => {
    const saveCalls: unknown[] = [];
    const slot = await mountStaff({
      subPath: "staff/hire",
      rpc: {
        save_agent_profile: (input) => {
          saveCalls.push(input);
          const payload = input as { id: string };
          return { ok: true, id: payload.id, sourceHash: "c".repeat(64) };
        },
      },
    });

    await slot.findByTestId("hire-step-role");
    fireEvent.click(slot.getByTestId("hire-custom-role-btn"));
    await slot.findByTestId("hire-custom-role-form");

    fireEvent.change(slot.getByTestId("hire-custom-id"), { target: { value: "pr-manager" } });
    fireEvent.change(slot.getByTestId("hire-custom-description"), {
      target: { value: "PR-менеджер" },
    });
    fireEvent.change(slot.getByTestId("hire-custom-prompt"), {
      target: { value: "Pitch tech media and write press releases." },
    });
    fireEvent.click(slot.getByTestId("hire-custom-save"));

    await waitFor(() => {
      expect(saveCalls).toHaveLength(1);
    });
    expect(saveCalls[0]).toMatchObject({
      id: "pr-manager",
      description: "PR-менеджер",
      prompt: "Pitch tech media and write press releases.",
      expectedSourceHash: "",
    });

    const createdChip = await slot.findByTestId("hire-role-pr-manager");
    expect(createdChip.getAttribute("aria-pressed")).toBe("true");
    expect(slot.queryByTestId("hire-custom-role-form")).toBeNull();

    slot.lifecycle.unmount();
  });
});

function tickScheduleFixture(state: "active" | "paused" = "active") {
  return {
    id: "sched_mkt_tick",
    projectId: "proj_alpha",
    name: "sp:marketing:sp-specialist-tick",
    description: "Marketing specialist shift",
    task: { kind: "workflow", workflowId: "sp-specialist-tick", inputs: { domain: "marketing" } },
    when: { type: "cron", cron: "0 */4 * * *", timezone: "UTC" },
    missed: "run_once",
    missedLimit: 5,
    overlap: "skip",
    timeoutSec: 3600,
    maxFailures: 3,
    state,
    pauseReason: null,
    consecutiveFailures: 0,
    createdBy: "owner",
    createdAt: 1_790_000_000_000,
    updatedAt: 1_790_000_000_000,
    nextFires: [1_800_014_400_000],
    machine: null,
    lastRun: null,
    active: [],
    column: state === "paused" ? "paused" : "scheduled",
    model: null,
    cost: null,
    where: {
      projectName: "Alpha shop",
      sectionId: null,
      sectionName: null,
      sectionPath: null,
      hostId: null,
      hostName: null,
      cwd: null,
    },
  };
}

describe("console staff page (P4)", () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
    setLocaleOverride("ru");
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  afterEach(() => {
    cleanup();
    setLocaleOverride(null);
    document.documentElement.lang = "en";
  });

  it("renders empty state with back link for unknown staff ref", async () => {
    const slot = await mountStaff({
      subPath: "staff/proj_alpha/unknown_domain",
    });

    const empty = await slot.findByTestId("staff-unknown");
    expect(empty.textContent).toContain("Сотрудник не найден");

    fireEvent.click(slot.getByTestId("staff-back-to-list"));
    await slot.findByTestId("console-staff");
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "lane-pilot",
      options: { subPath: "staff" },
    });

    slot.lifecycle.unmount();
  });

  it("renders header actions, charter fields, pending draft, and shifts/costs tabs", async () => {
    const runNowCalls: unknown[] = [];
    const pauseCalls: unknown[] = [];
    const detailCalls: unknown[] = [];

    const slot = await mountStaff({
      subPath: "staff/proj_alpha/marketing",
      rpc: {
        specialist_detail: (input) => {
          detailCalls.push(input);
          return defaultRpc().specialist_detail(input);
        },
        schedule_list: () => ({
          schedules: [tickScheduleFixture("active")],
          hosts: [],
          now: 1_800_000_000_000,
          errandDefault: {
            effective: null,
            source: null,
            project: null,
            global: null,
            projectVersion: 0,
            globalVersion: 0,
          },
        }),
        schedule_run_now: (input) => {
          runNowCalls.push(input);
          return { ok: true, run: null, created: true };
        },
        schedule_pause: (input) => {
          pauseCalls.push(input);
          return { schedule: tickScheduleFixture("paused") };
        },
      },
    });

    await slot.findByTestId("staff-page");
    expect(detailCalls).toEqual([{ projectId: "proj_alpha", domain: "marketing" }]);

    // Header: goal, current vs target, due, on-track pill, chat button.
    const headerGoal = slot.getByTestId("staff-header-goal").textContent ?? "";
    expect(headerGoal).toContain("600 оплативших заказов за 30 дней");
    expect(headerGoal).toContain("412");
    expect(headerGoal).toContain("600");
    expect(headerGoal).toContain("2027-03-01");
    expect(slot.getByTestId("staff-header-status").textContent).toContain("В графике");

    // Charter tab: metric, formula, data source, constraints, budgets, channels, version, pending draft.
    await slot.findByTestId("staff-charter-draft-banner");
    expect(slot.getByTestId("staff-charter-metric").textContent).toContain("paid_orders_30d");
    expect(slot.getByTestId("staff-charter-formula").textContent).toContain("SUM(orders.paid");
    expect(slot.getByTestId("staff-charter-data-source").textContent).toContain("CRM treba");
    expect(slot.getByTestId("staff-charter-constraints").textContent).toContain("600");
    expect(slot.getByTestId("staff-charter-budgets").textContent).toContain("450");
    expect(slot.getByTestId("staff-charter-channels").textContent).toContain("Яндекс Директ");
    expect(slot.getByTestId("staff-charter-version").textContent).toContain("Версия 3");
    expect(slot.getByTestId("staff-charter-version").textContent).toContain("owner");
    expect(slot.queryByTestId("staff-charter-edit-btn")).not.toBeNull();

    // «Запустить смену сейчас» calls schedule_run_now on tick schedule.
    await waitFor(() => {
      expect((slot.getByTestId("staff-run-now") as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(slot.getByTestId("staff-run-now"));
    await waitFor(() => {
      expect(runNowCalls).toEqual([{ id: "sched_mkt_tick" }]);
    });

    // «Открыть чат» navigates to specialist thread.
    fireEvent.click(slot.getByTestId("staff-open-chat"));
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "thr_sp_mkt_1",
    });

    // «Пауза сотрудника» goes through ConfirmDialog and calls schedule_pause.
    fireEvent.click(slot.getByTestId("staff-pause-btn"));
    const pauseConfirm = await slot.findByRole("alertdialog");
    const confirmBtn = Array.from(pauseConfirm.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("На паузу"),
    )!;
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(pauseCalls).toEqual([{ id: "sched_mkt_tick" }]);
    });

    // Costs tab: caps day/month/test bars.
    fireEvent.click(slot.getByTestId("seg-staff-tabs-costs"));
    await slot.findByTestId("staff-tab-costs");
    expect(slot.getByTestId("staff-cap-day").textContent).toContain("8");
    expect(slot.getByTestId("staff-cap-month").textContent).toContain("450");
    expect(slot.getByTestId("staff-cap-test").textContent).toContain("30");

    // Shifts tab: last/next, recent list, graph route -> system/graphs/<id> and run link.
    fireEvent.click(slot.getByTestId("seg-staff-tabs-shifts"));
    await slot.findByTestId("staff-tab-shifts");
    expect(slot.getByTestId("staff-shifts-last").textContent).toContain("daily_sweep");
    expect(slot.getByTestId("staff-shifts-next").textContent).toContain("heartbeat");

    fireEvent.click(slot.getByTestId("staff-shift-run-0"));
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "lane-pilot",
      options: { subPath: "work/task/wf_shift_1/wf_shift_1" },
    });

    slot.lifecycle.unmount();
  });

  it("routes shift chosen graph to system/graphs/<id>", async () => {
    const slot = await mountStaff({
      subPath: "staff/proj_alpha/marketing/shifts",
      rpc: {
        workflow_list: () => ({ workflows: [], problems: [], project: "ok" }),
        workflow_evolution_list: () => ({ items: [], pendingApprovalCount: 0, autoPublishedCount: 0 }),
      },
    });

    await slot.findByTestId("staff-tab-shifts");
    fireEvent.click(slot.getByTestId("staff-shift-graph-0"));
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "lane-pilot",
      options: { subPath: "system/graphs/mkt-pulse-monitor" },
    });

    slot.lifecycle.unmount();
  });

  it("does not run a non-tick schedule: with only the pulse monitor, «Запустить смену сейчас» is disabled with a reason", async () => {
    const runNowCalls: unknown[] = [];
    const pulse = {
      ...tickScheduleFixture("active"),
      id: "sched_mkt_pulse",
      name: "sp:marketing:mkt-pulse-monitor",
      task: { kind: "workflow", workflowId: "mkt-pulse-monitor", inputs: { domain: "marketing" } },
    };
    const slot = await mountStaff({
      subPath: "staff/proj_alpha/marketing",
      rpc: {
        schedule_list: () => ({
          schedules: [pulse],
          hosts: [],
          now: 1_800_000_000_000,
          errandDefault: { effective: null, source: null, project: null, global: null, projectVersion: 0, globalVersion: 0 },
        }),
        schedule_run_now: (input) => {
          runNowCalls.push(input);
          return { ok: true, run: null, created: true };
        },
      },
    });

    await slot.findByTestId("staff-page");
    // The pause button counts the pulse schedule, so the schedule list has arrived.
    await waitFor(() => expect((slot.getByTestId("staff-pause-btn") as HTMLButtonElement).disabled).toBe(false));
    const runNow = slot.getByTestId("staff-run-now") as HTMLButtonElement;
    expect(runNow.disabled).toBe(true);
    expect(slot.getByTestId("staff-run-now-wrap").getAttribute("title")).toBe("Нет расписания смены для запуска");
    fireEvent.click(runNow);
    expect(runNowCalls).toEqual([]);

    slot.lifecycle.unmount();
  });

  it("changes autonomy through ConfirmDialog, shows refusal reason, and renders repo_trust", async () => {
    const autonomyCalls: unknown[] = [];
    let shouldRefuse = false;

    const slot = await mountStaff({
      subPath: "staff/proj_alpha/marketing/autonomy",
      rpc: {
        repo_trust: () => ({
          repo: { root: "/repo/alpha", remote: "origin" },
          gate: { state: "passed", at: 1_800_000_000_000, fresh: true, reason: null },
          tests: { lastCount: 42 },
          rollbacks30d: 0,
          acceptedFirstTry30d: 0.91,
          level: "high",
          rules: [
            { actionClass: "merge_without_owner", mode: "auto" },
            { actionClass: "deploy", mode: "owner_only" },
          ],
        }),
        specialist_autonomy_set: (input) => {
          autonomyCalls.push(input);
          if (shouldRefuse) {
            return { ok: false, reason: "insufficient_sample_size" };
          }
          return {
            ok: true,
            autonomy: [
              {
                actionClass: "bid_adjust",
                level: "bounded_auto",
                sample: 34,
                confidence: 0.94,
                frozen: false,
              },
              {
                actionClass: "new_campaign",
                level: "observe",
                sample: 3,
                confidence: null,
                frozen: false,
              },
            ],
          };
        },
      },
    });

    await slot.findByTestId("staff-tab-autonomy");
    const repoTrustEl = await slot.findByTestId("staff-repo-trust");
    expect(repoTrustEl.textContent).toContain("Высокое доверие");
    expect(repoTrustEl.textContent).toContain("42");
    expect(repoTrustEl.textContent).toContain("91%");
    expect(repoTrustEl.textContent).toContain("merge_without_owner");

    // Raising bid_adjust to bounded_auto opens ConfirmDialog first without calling RPC yet.
    fireEvent.click(slot.getByTestId("seg-autonomy-level-bid_adjust-bounded_auto"));
    expect(autonomyCalls).toHaveLength(0);
    const dialog = await slot.findByRole("alertdialog");
    const confirmBtn = Array.from(dialog.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Подтвердить"),
    )!;
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(autonomyCalls).toEqual([
        {
          projectId: "proj_alpha",
          domain: "marketing",
          actionClass: "bid_adjust",
          level: "bounded_auto",
        },
      ]);
    });

    // Refused change displays reason banner.
    shouldRefuse = true;
    fireEvent.click(slot.getByTestId("seg-autonomy-level-new_campaign-bounded_auto"));
    const dialog2 = await slot.findByRole("alertdialog");
    const confirmBtn2 = Array.from(dialog2.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Подтвердить"),
    )!;
    fireEvent.click(confirmBtn2);

    const refused = await slot.findByTestId("staff-autonomy-refused");
    expect(refused.textContent).toContain("insufficient_sample_size");

    slot.lifecycle.unmount();
  });

  it("renders agent_loadout grouped by type and flags missing skill as «нет на хабе»", async () => {
    const slot = await mountStaff({
      subPath: "staff/proj_alpha/marketing/loadout",
      rpc: {
        agent_loadout: () => ({
          roles: [
            {
              role: "growth-marketer",
              kind: "specialist",
              model: {
                provider: "anthropic",
                model: "claude-sonnet-4-5",
                from: "project",
              },
              items: [
                { type: "skill", name: "mkt-end-to-end-analytics", from: "employee", missing: false },
                { type: "skill", name: "mkt-yandex-direct-epk", from: "domain_pack", missing: true },
                { type: "plugin", name: "env-catalog", from: "profile", missing: false },
                { type: "mcp", name: "bb-bridge", from: "required", missing: false },
              ],
              contextMode: "roles",
              machine: null,
              note: null,
            },
          ],
        }),
      },
    });

    await slot.findByTestId("staff-tab-loadout");
    expect(slot.getByTestId("staff-loadout-model").textContent).toContain("claude-sonnet-4-5");
    expect(slot.getByTestId("staff-loadout-model-from").textContent).toContain("project");
    expect(slot.getByTestId("staff-loadout-group-skill").textContent).toContain("mkt-end-to-end-analytics");
    expect(slot.getByTestId("staff-loadout-missing-mkt-yandex-direct-epk").textContent).toBe("нет на хабе");
    expect(slot.getByTestId("staff-loadout-missing-banner").textContent).toContain("нет на хабе");

    slot.lifecycle.unmount();
  });
});

describe("console charter editor (P4a)", () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
    setLocaleOverride("ru");
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  afterEach(() => {
    cleanup();
    setLocaleOverride(null);
    document.documentElement.lang = "en";
  });

  it("edits charter fields, saves draft without auto-approving budgets, shows side-by-side diff, and approves via ConfirmDialog", async () => {
    const baseDetail = defaultRpc().specialist_detail({
      projectId: "proj_alpha",
      domain: "marketing",
    }) as {
      charter: {
        version: number;
        approvedBy: string | null;
        approvedAt: number | null;
        body: Record<string, unknown>;
        pendingDraft: { draftId: string; body: Record<string, unknown> } | null;
      };
      [key: string]: unknown;
    };

    let state = {
      ...baseDetail,
      charter: {
        ...baseDetail.charter,
        pendingDraft: null as { draftId: string; body: Record<string, unknown> } | null,
      },
    };

    const proposeCalls: unknown[] = [];
    const approveCalls: unknown[] = [];

    const slot = await mountStaff({
      subPath: "staff/proj_alpha/marketing",
      rpc: {
        specialist_detail: () => state,
        charter_propose: (input) => {
          proposeCalls.push(input);
          const payload = input as { charter: Record<string, unknown> };
          state = {
            ...state,
            charter: {
              ...state.charter,
              pendingDraft: {
                draftId: "draft_v4_new",
                body: payload.charter,
              },
            },
          };
          return { draftId: "draft_v4_new" };
        },
        charter_approve: (input) => {
          approveCalls.push(input);
          const draftBody = state.charter.pendingDraft?.body ?? state.charter.body;
          state = {
            ...state,
            charter: {
              version: 4,
              approvedBy: "owner",
              approvedAt: 1_800_000_000_000,
              body: draftBody,
              pendingDraft: null,
            },
          };
          return { ok: true, version: 4 };
        },
      },
    });

    await slot.findByTestId("staff-tab-charter");
    fireEvent.click(slot.getByTestId("staff-charter-edit-btn"));
    await slot.findByTestId("charter-editor");

    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "lane-pilot",
      options: { subPath: "staff/proj_alpha/marketing/edit" },
    });

    // Form is prefilled from current charter body.
    expect((slot.getByTestId("charter-edit-metric") as HTMLInputElement).value).toBe("paid_orders_30d");
    expect((slot.getByTestId("charter-edit-target") as HTMLInputElement).value).toBe("600");
    expect((slot.getByTestId("charter-edit-budget-day") as HTMLInputElement).value).toBe("20");
    expect((slot.getByTestId("charter-edit-budget-month") as HTMLInputElement).value).toBe("450");
    expect((slot.getByTestId("charter-edit-budget-test") as HTMLInputElement).value).toBe("30");
    expect((slot.getByTestId("charter-edit-channels") as HTMLInputElement).value).toBe(
      "Яндекс Директ, Telegram Ads",
    );
    expect(slot.queryByTestId("charter-editor-diff")).toBeNull();

    // Update target, add a constraint, raise daily/monthly budgets, and add a graph to allowed channels.
    fireEvent.change(slot.getByTestId("charter-edit-target"), { target: { value: "750" } });
    fireEvent.click(slot.getByTestId("charter-edit-constraint-add"));
    fireEvent.change(slot.getByTestId("charter-edit-constraint-key-3"), {
      target: { value: "min_samples" },
    });
    fireEvent.change(slot.getByTestId("charter-edit-constraint-val-3"), {
      target: { value: "30" },
    });
    fireEvent.change(slot.getByTestId("charter-edit-budget-day"), { target: { value: "35" } });
    fireEvent.change(slot.getByTestId("charter-edit-budget-month"), { target: { value: "600" } });
    fireEvent.change(slot.getByTestId("charter-edit-channels"), {
      target: { value: "Яндекс Директ, Telegram Ads, mkt-experiment-cycle" },
    });

    // «Сохранить черновик» proposes draft and NEVER auto-approves budgets.
    fireEvent.click(slot.getByTestId("charter-save-draft-btn"));
    await waitFor(() => {
      expect(proposeCalls).toHaveLength(1);
    });
    expect(approveCalls).toHaveLength(0);
    expect(proposeCalls[0]).toMatchObject({
      projectId: "proj_alpha",
      domain: "marketing",
      charter: {
        north_star: { target: 750, metric_id: "paid_orders_30d" },
        guardrails: { max_cac: 600, min_samples: 30 },
        budgets: { daily_cap_usd: 35, monthly_cap_usd: 600, cell_cap_usd: 30 },
        channels: ["Яндекс Директ", "Telegram Ads", "mkt-experiment-cycle"],
      },
    });

    // Side-by-side diff appears with old and new values.
    await slot.findByTestId("charter-editor-diff");
    expect(slot.getByTestId("charter-diff-old-target").textContent).toBe("600");
    expect(slot.getByTestId("charter-diff-new-target").textContent).toBe("750");
    expect(slot.getByTestId("charter-diff-old-budgetDay").textContent).toBe("20");
    expect(slot.getByTestId("charter-diff-new-budgetDay").textContent).toBe("35");
    expect(slot.getByTestId("charter-diff-new-channels").textContent).toContain("mkt-experiment-cycle");

    // «Утвердить» opens ConfirmDialog first without calling charter_approve yet.
    fireEvent.click(slot.getByTestId("charter-approve-btn"));
    expect(approveCalls).toHaveLength(0);
    const dialog = await slot.findByRole("alertdialog");
    const confirmBtn = Array.from(dialog.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Утвердить"),
    )!;
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(approveCalls).toEqual([
        { projectId: "proj_alpha", domain: "marketing", draftId: "draft_v4_new" },
      ]);
    });

    // Returns to Charter tab showing the approved v4 charter without draft banner.
    await slot.findByTestId("staff-tab-charter");
    expect(slot.getByTestId("staff-charter-version").textContent).toContain("Версия 4");
    expect(slot.queryByTestId("staff-charter-draft-banner")).toBeNull();
    expect(slot.getByTestId("staff-charter-budgets").textContent).toContain("600");

    slot.lifecycle.unmount();
  });

  it("handles draft_not_found on approve by reloading detail and showing the stale-draft message", async () => {
    let detailReads = 0;
    let draftCleared = false;

    const slot = await mountStaff({
      subPath: "staff/proj_alpha/marketing/edit",
      rpc: {
        specialist_detail: (input) => {
          detailReads += 1;
          const base = defaultRpc().specialist_detail(input) as {
            charter: { pendingDraft: unknown; [k: string]: unknown };
            [k: string]: unknown;
          };
          if (!draftCleared) return base;
          return {
            ...base,
            charter: { ...base.charter, pendingDraft: null },
          };
        },
        charter_approve: () => {
          draftCleared = true;
          return { ok: false, reason: "draft_not_found" };
        },
      },
    });

    await slot.findByTestId("charter-editor-diff");
    expect(slot.getByTestId("charter-diff-old-target").textContent).toBe("600");
    expect(slot.getByTestId("charter-diff-new-target").textContent).toBe("700");

    const readsBeforeApprove = detailReads;
    fireEvent.click(slot.getByTestId("charter-approve-btn"));
    const dialog = await slot.findByRole("alertdialog");
    const confirmBtn = Array.from(dialog.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Утвердить"),
    )!;
    fireEvent.click(confirmBtn);

    const errAlert = await slot.findByTestId("charter-editor-error");
    expect(errAlert.textContent).toContain("Черновик уже утверждён или удалён");
    await waitFor(() => {
      expect(detailReads).toBeGreaterThan(readsBeforeApprove);
    });
    expect(slot.queryByTestId("charter-editor-diff")).toBeNull();

    slot.lifecycle.unmount();
  });

  it("shows a budget the draft cleared as removed, because approving writes the draft body as the whole charter", async () => {
    const slot = await mountStaff({
      subPath: "staff/proj_alpha/marketing/edit",
      rpc: {
        specialist_detail: (input) => {
          const base = defaultRpc().specialist_detail(input) as {
            charter: { body: Record<string, unknown>; [k: string]: unknown };
            [k: string]: unknown;
          };
          const { daily_cap_usd: _cleared, ...budgets } = base.charter.body.budgets as Record<string, unknown>;
          return {
            ...base,
            charter: { ...base.charter, pendingDraft: { draftId: "draft_v4", body: { ...base.charter.body, budgets } } },
          };
        },
      },
    });

    await slot.findByTestId("charter-editor-diff");
    expect(slot.getByTestId("charter-diff-old-budgetDay").textContent).toBe("20");
    expect(slot.getByTestId("charter-diff-new-budgetDay").textContent).toBe("—");
    expect((slot.getByTestId("charter-edit-budget-day") as HTMLInputElement).value).toBe("");

    slot.lifecycle.unmount();
  });

  it("disables saving draft when negative budget or target is entered", async () => {
    const slot = await mountStaff({
      subPath: "staff/proj_alpha/marketing/edit",
    });

    await slot.findByTestId("charter-editor");
    fireEvent.change(slot.getByTestId("charter-edit-budget-day"), { target: { value: "-5" } });
    expect((slot.getByTestId("charter-save-draft-btn") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(slot.getByTestId("charter-edit-budget-day"), { target: { value: "25" } });
    expect((slot.getByTestId("charter-save-draft-btn") as HTMLButtonElement).disabled).toBe(false);

    slot.lifecycle.unmount();
  });
});
