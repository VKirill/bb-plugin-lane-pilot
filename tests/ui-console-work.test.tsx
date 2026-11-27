/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import { boardFixture, cardFixture, screenFixture } from "./ui-harness";

vi.setConfig({ testTimeout: 60_000 });
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
configure({ asyncUtilTimeout: 10_000 });

const PROJECTS = [
  { id: "proj_ui", name: "UI test" },
  { id: "proj_alpha", name: "Alpha app" },
];

function defaultRpc(overrides: Record<string, (input: unknown) => unknown> = {}) {
  const baseScreen = screenFixture();
  return {
    get_preferences: (input: unknown) => ({
      locale: (input as { suggestedLocale: "en" | "ru" }).suggestedLocale,
      preference: "auto",
      lastProjectId: null,
    }),
    set_locale: (input: unknown) => ({
      locale: (input as { locale: "auto" | "en" | "ru"; suggestedLocale: "en" | "ru" }).locale === "auto"
        ? (input as { suggestedLocale: "en" | "ru" }).suggestedLocale
        : (input as { locale: "en" | "ru" }).locale,
      preference: (input as { locale: "auto" | "en" | "ru" }).locale,
    }),
    remember_project: () => ({ ok: true }),
    list_projects: () => ({ projects: PROJECTS, lastProjectId: "proj_ui" }),
    list_sections: () => ({ sections: [] }),
    get_routing_hint: () => ({ current: null, stats: [] }),
    get_screen: (input: unknown) => ({ ...baseScreen, projectId: (input as { projectId?: string }).projectId ?? "proj_ui" }),
    task_board: () => boardFixture(),
    task_card: () => cardFixture(),
    work_graph_strips: () => ({}),
    specialist_overview: () => ({ breakers: [], pendingIntents: 0, dispatchedCount: 0, openQuestionsCount: 0, artifactsCount: 0, spend30dUsd: 0 }),
    owner_waiting: () => ({
      generatedAt: 1_800_000_000_000,
      now: 0,
      counts: {},
      overnight: { windowMs: 86_400_000, red: [], accepted: 0, rulesAdopted: 0, rulesConfirmed: 0 },
      answered: { owner: 0, agent: 0, lead: 0, janitor: 0 },
      items: [],
    }),
    workflow_runs: (input: unknown) => {
      const { id } = input as { id: string };
      if (id === "full-lifecycle") {
        return {
          runs: [{
            id: "wfrun_fl_1",
            status: "running",
            reason: null,
            mode: "standard",
            createdAt: 1_790_000_000_000,
            updatedAt: 1_790_000_100_000,
            tokens: 1200,
            costUsd: 0.42,
            parentRunId: null,
            stepsUsed: 2,
          }],
          hasMore: false,
        };
      }
      if (id === "project-start") {
        return {
          runs: [{
            id: "wfrun_ps_1",
            status: "succeeded",
            reason: null,
            mode: null,
            createdAt: 1_789_000_000_000,
            updatedAt: 1_789_000_100_000,
            tokens: 500,
            costUsd: 0.1,
            parentRunId: null,
            stepsUsed: 4,
          }],
          hasMore: false,
        };
      }
      if (id === "roadmap-driven") {
        return { runs: [], hasMore: false };
      }
      return {
        runs: [{
          id: "wfrun_other_99",
          status: "succeeded",
          reason: null,
          mode: null,
          createdAt: 1_788_000_000_000,
          updatedAt: 1_788_000_100_000,
          tokens: 100,
          costUsd: 0.01,
          parentRunId: null,
          stepsUsed: 1,
        }],
        hasMore: false,
      };
    },
    workflow_run_snapshot: (input: unknown) => ({
      snapshot: {
        run: {
          id: (input as { runId: string }).runId,
          workflowId: "full-lifecycle",
          version: 1,
          status: "running",
          reason: null,
          mode: "standard",
          projectId: "proj_ui",
          createdAt: 1_790_000_000_000,
          updatedAt: 1_790_000_100_000,
          tokens: 1200,
          costUsd: 0.42,
          parentRunId: null,
          parentStepKey: null,
          stepsUsed: 2,
          inputs: { goal: "Ship billing" },
          output: null,
        },
        graph: {
          nodes: [
            { id: "start", kind: "start", tone: "terminal", title: null, label: "start", role: null, excerpt: null, uses: null, out: [] },
            { id: "contract", kind: "agent", tone: "agent", title: { en: "Boundary and goals", ru: "Граница и цели" }, label: null, role: "planner", excerpt: null, uses: null, out: [] },
            { id: "build", kind: "subworkflow", tone: "subworkflow", title: { en: "Build", ru: "Сборка" }, label: null, role: null, excerpt: null, uses: null, out: [] },
            { id: "end", kind: "end", tone: "terminal", title: null, label: "end", role: null, excerpt: null, uses: null, out: [] },
          ],
          edges: [],
        },
        steps: [
          { key: "contract#1", nodeId: "contract", state: "succeeded", visit: 1, scope: "root", attempt: 1, parentKey: null, edgeIndex: null, startedAt: 1, endedAt: 2, error: null, threadId: null, handoff: null, awaiting: null, input: null, output: null },
          { key: "build#1", nodeId: "build", state: "running", visit: 1, scope: "root", attempt: 1, parentKey: null, edgeIndex: null, startedAt: 2, endedAt: null, error: null, threadId: null, handoff: null, awaiting: null, input: null, output: null },
        ],
        children: [],
        goals: [{ id: "g1", done_when: "Billing flows work", evidence: "tests" }],
        goalAudit: null,
        goalChanges: [],
        events: [],
      },
    }),
    workflow_get: (input: unknown) => ({
      workflow: {
        id: (input as { id: string }).id,
        name: { en: "Full lifecycle", ru: "Полный цикл" },
        description: { en: "End-to-end", ru: "Полный цикл" },
        status: "published",
        version: 1,
        scope: "builtin",
        internal: false,
        kind: "project",
        tags: [],
        nodes: 3,
        warnings: 0,
        stats: { active: 0, succeeded: 0, failed: 0, refused: 0, escalated: 0, runs30d: 0, successRate: null, lastRunAt: null, lastStatus: null, lastRunId: null },
        examples: { en: [], ru: [] },
        inputs: [{ name: "goal", type: "string", required: true, note: "Main goal" }],
        outputs: [],
        triggers: [],
        requires: [],
        budget: { maxTokens: null, maxCostUsd: null, maxWallSeconds: null },
        qualityMode: "standard",
        source: "workflows/full-lifecycle.json",
        sha256: "abc",
        startedBy: null,
        proven: null,
        proven_on: [],
        schedules: [],
        warningMessages: [],
        graph: { nodes: [], edges: [] },
        runs: [],
      },
    }),
    workflow_run: () => ({ ok: true, runId: "wfrun_new_1", created: true, status: "running" }),
    errands_overview: () => ({ days: 7, kinds: [], errands: [] }),
    errands_diagnosis: () => null,
    get_role_models: () => ({ roles: [] }),
    ...overrides,
  };
}

async function mountWork({
  subPath = "work/tasks",
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

describe("console work section (P5)", () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    cleanup();
    setLocaleOverride(null);
    document.documentElement.lang = "en";
  });

  it("routes a task card click to work/task/<runId>/<taskId> and hides project select when scoped to a project", async () => {
    const slot = await mountWork({ subPath: "work/tasks", projectId: "proj_ui" });
    await slot.findByTestId("console-work");
    const card = await slot.findByTestId("board-card-task:lprun_1:task_1");

    // Scope is owned by the shell: TaskBoard's own project dropdown is hidden when scoped.
    expect(slot.queryByTestId("board-project")).toBeNull();

    fireEvent.click(card);
    await waitFor(() =>
      expect(slot.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "lane-pilot",
        options: { subPath: "work/task/lprun_1/task_1" },
      }),
    );
    slot.lifecycle.unmount();
  });

  it("lists runs of project-start, full-lifecycle, roadmap-driven only, lazily loads stages, and starts a project via workflow_run", async () => {
    const workflowRunsCalls: unknown[] = [];
    const workflowRunCalls: unknown[] = [];
    const slot = await mountWork({
      subPath: "work/projects",
      projectId: "proj_ui",
      rpc: {
        workflow_runs: (input) => {
          workflowRunsCalls.push(input);
          return defaultRpc().workflow_runs(input);
        },
        workflow_run: (input) => {
          workflowRunCalls.push(input);
          return { ok: true, runId: "wfrun_new_1", created: true, status: "running" };
        },
      },
    });

    await slot.findByTestId("big-projects");
    await slot.findByTestId("big-project-run-wfrun_fl_1");
    await slot.findByTestId("big-project-run-wfrun_ps_1");
    expect(slot.queryByTestId("big-project-run-wfrun_other_99")).toBeNull();

    const queriedIds = workflowRunsCalls.map((call) => (call as { id: string }).id).sort();
    expect(queriedIds).toEqual(["full-lifecycle", "project-start", "roadmap-driven"]);
    expect(slot.rpcCalls.some((call) => call.method === "workflow_run_snapshot")).toBe(false);

    // Expanding a run lazily fetches workflow_run_snapshot and renders its stages row.
    fireEvent.click(slot.getByTestId("big-project-toggle-wfrun_fl_1"));
    const stages = await slot.findByTestId("big-project-stages-wfrun_fl_1");
    expect(stages.textContent).toContain("Boundary and goals");
    expect(stages.textContent).toContain("Build");
    expect(slot.rpcCalls.some((call) => call.method === "workflow_run_snapshot")).toBe(true);

    // «Start project» loads workflow_get, renders InputsForm, and triggers workflow_run.
    fireEvent.click(slot.getByTestId("big-projects-start"));
    await slot.findByTestId("big-projects-start-panel");
    const goalInput = await slot.findByTestId("wf-input-goal");
    fireEvent.change(goalInput, { target: { value: "Launch new billing" } });
    fireEvent.click(slot.getByTestId("wf-inputs-submit"));

    await waitFor(() =>
      expect(workflowRunCalls).toContainEqual({
        id: "full-lifecycle",
        projectId: "proj_ui",
        inputs: { goal: "Launch new billing" },
        source: "manual",
      }),
    );
    slot.lifecycle.unmount();
  });

  it("switches between tasks, projects, and errands tabs via route.view", async () => {
    const slot = await mountWork({ subPath: "work/tasks" });
    await slot.findByTestId("task-board");
    expect(slot.getByTestId("board-project")).toBeTruthy();

    fireEvent.click(slot.getByTestId("seg-work-view-projects"));
    await slot.findByTestId("big-projects");
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "lane-pilot",
      options: { subPath: "work/projects" },
    });

    fireEvent.click(slot.getByTestId("seg-work-view-errands"));
    await slot.findByTestId("errands-screen");
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "lane-pilot",
      options: { subPath: "work/errands" },
    });
    slot.lifecycle.unmount();
  });
});
