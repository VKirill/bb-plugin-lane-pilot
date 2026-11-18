/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, render, waitFor } from "@testing-library/react";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import type { PilotPanelSnapshot } from "../src/rooms/pilot-panel";
import { PilotDelegationSection } from "../src/rooms/pilot-panel/ui/delegation-section";
import { PilotReadinessSection } from "../src/rooms/pilot-panel/ui/readiness-section";

vi.setConfig({ testTimeout: 30_000 });
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
configure({ asyncUtilTimeout: 8_000 });

const rpcCalls: Array<{ method: string; args: unknown }> = [];
let mockSnapshot: PilotPanelSnapshot;

vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  return {
    ...actual,
    useRpc: () => ({
      call: async (method: string, args: unknown) => {
        rpcCalls.push({ method, args });
        if (method === "pilot_panel_status") return mockSnapshot;
        if (method === "pilot_panel_run_action") {
          return { sent: true, message: "Проект подготовлен: синхронизировано скиллов в .bb/skills/ — 11." };
        }
        if (method === "pilot_panel_set_readiness_skip") return { ok: true };
        if (method === "pilot_panel_set_delegation") return mockSnapshot.delegation;
        return {};
      },
    }),
    useBbNavigate: () => ({
      toThread: vi.fn(),
      toPluginPanel: vi.fn(),
    }),
    experimental_Icon: ({ name, className }: { name: string; className?: string }) => (
      <span data-icon={name} className={className} />
    ),
    experimental_ProviderModelPicker: ({
      value,
      onChange,
    }: {
      value: { providerId: string; model: string; reasoningLevel?: string };
      onChange: (next: { providerId: string; model: string; reasoningLevel?: string }) => void;
    }) => (
      <button
        type="button"
        data-testid="mock-model-picker"
        onClick={() => onChange({ providerId: "codex", model: "gpt-5.4", reasoningLevel: "high" })}
      >
        {value.providerId}:{value.model || "select"}
      </button>
    ),
  };
});

vi.mock("../src/rooms/ui-shell/ui", () => ({
  useLpRealtime: () => undefined,
  useCockpitPageTitle: () => null,
  useOwnerWaitingBadge: () => null,
}));

function makeSnapshotFixture(): PilotPanelSnapshot {
  return {
    collectedAt: "2026-11-18T07:00:00.000Z",
    fingerprint: "fp_demo_1",
    pluginVersion: "0.1.595",
    project: {
      id: "proj_demo",
      name: "BB Demo Project",
      hostId: "host_local",
      rootPath: "/workspace/bb-demo",
      environmentId: "env_demo",
      gitBranch: "main",
      gitDirty: false,
    },
    session: {
      threadId: "thr_main",
      threadState: "idle",
      pendingQuestions: 0,
      role: "pm",
      cleanSubthreadsActive: true,
      serviceTierPolicy: "standard",
      activeRun: {
        runId: "lprun_42",
        pmThreadId: "thr_main",
        state: "running",
        conveyorOn: true,
      },
      runItems: [
        {
          key: "lprun_42:task_1",
          runId: "lprun_42",
          taskId: "task_1",
          title: "Подключить правую панель пилота",
          column: "running",
          phase: "running",
          stage: "writer",
          model: "claude-sonnet-4-6",
          threadId: "thr_writer_1",
          detail: null,
          kind: "task",
        },
      ],
    },
    readiness: [
      { id: "install", label: "Скиллы и .agents/pilot в проекте", state: "done", missing: [], anyOf: false, skippable: false, actionId: "prepare-project" },
      { id: "context", label: "Описание проекта и правила", state: "todo", missing: [".agents/pilot/DESCRIPTION.md"], anyOf: false, skippable: false, actionId: "setup-context" },
      { id: "architecture", label: "Архитектура модулей", state: "todo", missing: [".agents/pilot/ARCHITECTURE.md"], anyOf: false, skippable: false, actionId: "setup-architecture" },
      { id: "quality", label: "Локальные Git-хуки", state: "todo", missing: [".husky"], anyOf: true, skippable: true, actionId: "quality-setup" },
      { id: "ci", label: "CI-пайплайн", state: "done", missing: [], anyOf: false, skippable: true, actionId: "ci-setup" },
    ],
    projectSkills: {
      rootRelPath: ".bb/skills",
      total: 11,
      synced: 11,
      items: [
        { name: "lane-pilot", state: "synced" },
        { name: "lp-project-setup", state: "synced" },
        { name: "lp-plan", state: "synced" },
        { name: "lp-implement", state: "synced" },
        { name: "lp-verify", state: "synced" },
      ],
    },
    plans: {
      candidates: [{ path: ".agents/pilot/plans/pilot-panel.md", title: "Pilot Panel Plan", done: 1, total: 2 }],
      selected: {
        path: ".agents/pilot/plans/pilot-panel.md",
        title: "Pilot Panel Plan",
        tasks: [
          { id: "1", title: "Task 1: Header icon", state: "done" },
          { id: "2", title: "Task 2: Project readiness", state: "todo" },
        ],
      },
    },
    delegation: {
      choice: { mode: "pilot-lanes" },
      configured: true,
      error: null,
      providers: [{ id: "claude-code", name: "Claude Code" }, { id: "codex", name: "Codex" }],
      children: [
        {
          id: "thr_sub_1",
          title: "LP · panel · Task 1",
          status: "active",
          role: "writer",
          providerId: "claude-code",
          cleanSession: true,
        },
      ],
    },
    actions: [
      {
        id: "setup-context",
        label: "Описать проект (/lp-project-setup)",
        command: "/lp-project-setup",
        reason: "Заполнить DESCRIPTION.md и rules/base.md",
        group: "setup",
        available: true,
      },
      {
        id: "implement",
        label: "Продолжить план (1 осталось)",
        command: "/lp-implement .agents/pilot/plans/pilot-panel.md",
        reason: "Выполнить оставшиеся задачи",
        group: "next",
        available: true,
      },
    ],
    diagnostics: [],
  };
}

describe("Lane Pilot chat header icon and right-hand thread panel UI", () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
    rpcCalls.length = 0;
    mockSnapshot = makeSnapshotFixture();
  });

  afterEach(() => {
    cleanup();
  });

  it("registers the dedicated Compass header icon action and fixed right-hand thread tab in app.tsx", async () => {
    const registeredTabs: Array<Record<string, unknown>> = [];
    const registeredThreadActions: Array<Record<string, unknown>> = [];
    const appMod = await import("../app");
    const fakeApp = {
      contentScripts: { register: vi.fn() },
      commands: { register: vi.fn() },
      markdown: { registerDirective: vi.fn() },
      composer: { customize: vi.fn() },
      slots: {
        navPanel: vi.fn(),
        composer: vi.fn(),
        composerFooter: vi.fn(),
        messageDirective: vi.fn(),
        pendingInteraction: vi.fn(),
        threadHeaderAction: vi.fn(),
        experimental_tab: (reg: Record<string, unknown>) => registeredTabs.push(reg),
        experimental_threadAction: (reg: Record<string, unknown>) => registeredThreadActions.push(reg),
        experimental_threadInfoSection: vi.fn(),
        experimental_threadRowMetadata: vi.fn(),
        experimental_userInputRenderer: vi.fn(),
        experimental_THREAD_ACTION_GROUPS: { inspect: "inspect" },
      },
    };
    const loaded = await loadPluginApp(() => import("../app"));
    expect(loaded.navPanels.length).toBeGreaterThanOrEqual(3);

    const setupFn = (appMod.default as unknown as { setup?: (a: unknown) => void }).setup;
    expect(typeof setupFn).toBe("function");
    setupFn!(fakeApp);
    const fixedTab = registeredTabs.find((t) => t.id === "pilot-panel");
    expect(fixedTab).toMatchObject({
      id: "pilot-panel",
      icon: "Compass",
      availability: "fixed",
      context: { kind: "thread" },
    });
    const headerAction = registeredThreadActions.find((a) => a.id === "open-pilot-panel");
    expect(headerAction).toMatchObject({
      id: "open-pilot-panel",
      icon: "Compass",
      placement: "header",
    });
  });

  it("renders project context, readiness checklist with ? help, session tasks, plan progress, clean subthreads, and .bb/skills status", async () => {
    const { PilotThreadPanel } = await import("../src/rooms/pilot-panel/ui");
    const view = render(<PilotThreadPanel threadId="thr_main" environment={{ id: "env_demo" }} />);

    await waitFor(() => expect(view.getByText("BB Demo Project")).toBeTruthy());
    expect(view.getByText("/workspace/bb-demo")).toBeTruthy();
    expect(view.getAllByText(/11\/11/).length).toBeGreaterThanOrEqual(2);
    expect(view.getByText("Pilot Panel Plan")).toBeTruthy();
    expect(view.getByText("LP · panel · Task 1")).toBeTruthy();
    expect(view.getByText("Подключить правую панель пилота")).toBeTruthy();

    // Click `?` help button on step 2 to reveal contextual explanation.
    const helpBtn = view.getByLabelText("Что делает шаг «Описание проекта и правила»");
    fireEvent.click(helpBtn);
    await waitFor(() =>
      expect(view.getByText(/анализирует стек, команды проверок и конвенции репозитория/)).toBeTruthy(),
    );

    // Trigger next action button and verify RPC call.
    fireEvent.click(view.getByText("Продолжить план (1 осталось)"));
    await waitFor(() =>
      expect(rpcCalls.some((c) => c.method === "pilot_panel_run_action")).toBe(true),
    );
    expect(PilotDelegationSection).toBeTypeOf("function");
    expect(PilotReadinessSection).toBeTypeOf("function");
  });
});
