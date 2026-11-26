/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { THREAD_LIVE_TAB_ID, ThreadLivePanel } from "../src/rooms/runs/ui";
import { WorkflowsScreen } from "../src/rooms/workflow/ui/workflows";

vi.setConfig({ testTimeout: 30_000 });
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

const rpcCalls: Array<{ method: string; args: unknown }> = [];
const threadSends: Array<unknown> = [];
let mockPublishHandler: ((args: unknown) => Promise<unknown>) | null = null;
let mockRollbackHandler: ((args: unknown) => Promise<unknown>) | null = null;

const rpcHandlers = {
  thread_live: async (args: unknown) => {
    rpcCalls.push({ method: "thread_live", args });
    return {
      role: "pm",
      pmThreadId: "thr_main",
      session: { runId: "lprun_42", state: "running", kind: "native" },
      items: [
        {
          key: "t1",
          runId: "lprun_42",
          taskId: "t1",
          title: "Wire live thread tab",
          column: "running",
          phase: "implementing",
          stage: "implement",
          model: "gpt-6",
          since: Date.now() - 60_000,
          threadId: "thr_w1",
          updatedAt: Date.now(),
          detail: null,
        },
      ],
      strips: {},
    };
  },
  workflow_list: async (args: unknown) => { rpcCalls.push({ method: "workflow_list", args }); return { workflows: [], problems: [] }; },
  workflow_draft_list: async (args: unknown) => { rpcCalls.push({ method: "workflow_draft_list", args }); return { drafts: [] }; },
  workflow_evolution_list: async (args: unknown) => {
    rpcCalls.push({ method: "workflow_evolution_list", args });
    return {
      items: [
        {
          draftId: "wfd_new_1",
          workflowId: "new-site-archetype",
          title: "New site archetype",
          scope: "global",
          status: "tested",
          version: 1,
          publishedVersion: null,
          testedGreen: true,
          canPublish: true,
          canRollback: false,
          summary: "Proposed site archetype workflow",
          ownerItemKey: "workflow-draft:wfd_new_1:v1",
          updatedAt: Date.now(),
        },
        {
          draftId: "wfd_evo_2",
          workflowId: "universal-landing-flow",
          title: "Universal landing flow",
          scope: "global",
          status: "published",
          version: 2,
          publishedVersion: 2,
          testedGreen: true,
          canPublish: false,
          canRollback: true,
          summary: "Updated copy step",
          ownerItemKey: null,
          updatedAt: Date.now(),
        },
      ],
      autoPublishedCount: 1,
      pendingApprovalCount: 1,
    };
  },
  workflow_evolution_publish: async (args: unknown) => {
    rpcCalls.push({ method: "workflow_evolution_publish", args });
    if (mockPublishHandler) return mockPublishHandler(args);
    return { ok: true, message: "Граф new-site-archetype (v1) опубликован." };
  },
  workflow_draft_rollback: async (args: unknown) => {
    rpcCalls.push({ method: "workflow_draft_rollback", args });
    if (mockRollbackHandler) return mockRollbackHandler(args);
    return { ok: true, message: "Граф universal-landing-flow откачен и опубликован (v1)." };
  },
};

vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@get-bb/plugin-sdk/app")>();
  return {
    ...actual,
    useSdk: () => ({
      threads: {
        send: async (req: unknown) => {
          threadSends.push(req);
          return { id: "msg_1" };
        },
      },
    }),
    useBbNavigate: () => ({ toThread: vi.fn(), toPluginPanel: vi.fn() }),
  };
});

beforeEach(() => {
  rpcCalls.length = 0;
  threadSends.length = 0;
  mockPublishHandler = null;
  mockRollbackHandler = null;
});

afterEach(() => cleanup());

describe("fixed ThreadLive tab and Workflows evolution UI", () => {
  it("registers only Lane Pilot main navPanel + live fixed thread tab and no council/cockpit/pilot-panel", async () => {
    const loaded = await loadPluginApp(() => import("../app"));
    expect(loaded.navPanels.map((p) => p.id)).toEqual(["lane-pilot"]);

    const appMod = await import("../app");
    const registeredTabs: Array<{ id: string; availability?: string; context?: { kind: string } }> = [];
    const registeredActions: Array<{ id: string; placement?: string }> = [];
    const fakeApp = {
      slots: {
        navPanel: vi.fn(),
        messageDirective: vi.fn(),
        pendingInteraction: vi.fn(),
        experimental_tab: (reg: { id: string; availability?: string; context?: { kind: string } }) => registeredTabs.push(reg),
        experimental_threadAction: (reg: { id: string; placement?: string }) => registeredActions.push(reg),
      },
      commands: { register: vi.fn() },
      composer: { customize: vi.fn() },
      contentScripts: { register: vi.fn() },
    };
    (appMod.default as unknown as { setup?: (a: unknown) => void }).setup?.(fakeApp);

    expect(registeredTabs.find((t) => t.id === THREAD_LIVE_TAB_ID)).toMatchObject({
      id: THREAD_LIVE_TAB_ID,
      availability: "fixed",
      context: { kind: "thread" },
    });
    expect(registeredTabs.some((t) => t.id === "pilot-panel")).toBe(false);
    expect(registeredActions.find((a) => a.id === "open-thread-live")).toMatchObject({
      id: "open-thread-live",
      placement: "header",
    });
  });

  it("renders ThreadLivePanel with task list and follow-up box using sdk.threads.send", async () => {
    const view = renderSlot(
      { component: () => <ThreadLivePanel threadId="thr_main" locale="en" /> } as never,
      {},
      { context: { projectId: "proj_1", threadId: "thr_main" }, rpc: rpcHandlers as never },
    );
    await waitFor(() => expect(view.getByText("Wire live thread tab")).toBeTruthy());

    fireEvent.change(view.getByTestId("thread-live-followup-input"), { target: { value: "Check test status" } });
    fireEvent.click(view.getByTestId("thread-live-followup-send"));
    await waitFor(() => expect(threadSends).toEqual([
      {
        threadId: "thr_main",
        mode: "queue-if-active",
        input: [{ type: "text", text: "Check test status", mentions: [] }],
      },
    ]));
  });

  it("renders workflow evolution drafts in WorkflowsScreen with 1-click publish/rollback and error feedback", async () => {
    const view = renderSlot(
      { component: () => <WorkflowsScreen locale="en" projectId="proj_1" /> } as never,
      {},
      { context: { projectId: "proj_1", threadId: null }, rpc: rpcHandlers as never },
    );
    await waitFor(() => expect(view.getByTestId("workflow-evolution")).toBeTruthy());
    expect(view.getByText("New site archetype")).toBeTruthy();
    expect(view.getByText("Universal landing flow")).toBeTruthy();

    fireEvent.click(view.getByTestId("wf-evo-publish-wfd_new_1"));
    await waitFor(() => expect(rpcCalls.some((c) => c.method === "workflow_evolution_publish")).toBe(true));
    await waitFor(() => expect(view.getByTestId("wf-evolution-feedback").textContent).toContain("опубликован"));

    fireEvent.click(view.getByTestId("wf-evo-rollback-wfd_evo_2"));
    await waitFor(() => expect(rpcCalls.some((c) => c.method === "workflow_draft_rollback")).toBe(true));

    mockPublishHandler = async () => ({ ok: false, message: "publish rejected" });
    fireEvent.click(view.getByTestId("wf-evo-publish-wfd_new_1"));
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("publish rejected"));
  });
});
