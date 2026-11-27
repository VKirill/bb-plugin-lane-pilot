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
